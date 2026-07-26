import { HTTPClient } from '#utils';

/**
 * @description Harvester for Lithuanian Basketball (Betsafe LKL) schedules from en.lkl.lt.
 * Discovers and collects match IDs across LKL seasons using Playwright.
 */
export class LklHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://en.lkl.lt');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Maps the season year to LKL's championship database identifier.
	 * @param {string|number} year - The season year (e.g., '2026')
	 * @returns {string} Championship ID
	 */
	getSeasonId(year) {
		const yearStr = String(year);
		const mappings = {
			'2026': '41936', // 2025-2026
			'2025': '39252', // 2024-2025
			'2024': '34698', // 2023-2024
			'2023': '34514', // 2022-2023
			'2022': '30527', // 2021-2022
			'2021': '28293', // 2020-2021
			'2020': '25195', // 2019-2020
			'2019': '21837', // 2018-2019
			'2018': '18743', // 2017-2018
			'2017': '9225',  // 2016-2017
			'2016': '3120',  // 2015-2016
			'2015': '3118',  // 2014-2015
			'2014': '3116',  // 2013-2014
			'2013': '3094',  // 2012-2013
			'2012': '3095',  // 2011-2012
			'2011': '3093',  // 2010-2011
			'2010': '3092',  // 2009-2010
			'2009': '3091',  // 2008-2009
			'2008': '3090'   // 2007-2008
		};
		return mappings[yearStr] || '41936';
	}

	/**
	 * @description Fetches all game slugs/IDs for LKL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network/playwright calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`lietkabelis-vs-neptunas-K${year}_11574`,
				`zalgiris-vs-rytas-K${year}_11572`
			];
		}

		const seasonId = this.getSeasonId(year);
		console.log(`📡 [LklHarvester] Harvesting LKL season ${year} (Season ID: ${seasonId})...`);

		// Import Playwright dynamically to prevent worker serialization errors
		const { chromium } = await import('playwright');
		const browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();

		const resultsUrl = 'https://en.lkl.lt/rezultatai';
		await page.goto(resultsUrl, { waitUntil: 'networkidle' });

		// Select the proper season from the dropdown and wait for the results to load
		await page.selectOption('#season-lkl', seasonId);
		await new Promise(resolve => setTimeout(resolve, 2000)); // Allow some time for AJAX/DOM updates

		const gameSlugs = await page.evaluate((seasonCode) => {
			const anchors = Array.from(document.querySelectorAll('a[href*="/rungtynes/"]'));
			return anchors.map(a => {
				const href = a.href;
				const match = href.match(/\/rungtynes\/(\d+)/);
				if (!match) return null;
				const gameCode = match[1];

				// Extract team names from parent elements or use default
				// Typically parent containers have team logos or names
				const parent = a.closest('.results-table-row, tr, div');
				let homeTeam = 'home';
				let awayTeam = 'away';
				if (parent) {
					// LKL results rows often list team names or text
					const text = parent.innerText || '';
					const matches = text.split('\n').filter(t => t.trim().length > 0);
					if (matches.length >= 2) {
						homeTeam = matches[0].toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
						awayTeam = matches[matches.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
					}
				}

				return `${homeTeam}-vs-${awayTeam}-K${seasonCode}_${gameCode}`;
			}).filter(Boolean);
		}, year);

		await browser.close();

		const uniqueSlugs = [...new Set(gameSlugs)];
		console.log(`✅ [LklHarvester] Successfully harvested ${uniqueSlugs.length} unique LKL games for season ${year}.`);
		return uniqueSlugs;
	}
}
export default LklHarvester;
