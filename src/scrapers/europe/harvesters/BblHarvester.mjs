import { HTTPClient } from '#utils';

/**
 * @description Harvester for easyCredit Basketball Bundesliga (BBL) schedules.
 * Discovers and collects match IDs from easycredit-bbl.de using Playwright.
 */
export class BblHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.easycredit-bbl.de');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for BBL for a given season.
	 * @param {string|number} year - The season start year (e.g. 2024)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`fc-bayern-vs-alba-berlin-D${year}_48210`,
				`ratiopharm-ulm-vs-telekom-baskets-bonn-D${year}_48211`
			];
		}

		console.log(`📡 [BblHarvester] Harvesting BBL season ${year} using Playwright...`);

		const scheduleUrl = `${this.baseUrl}/saison/spielplaene_liga-pokalspiele/hauptrunde?season=${year}`;
		let browser = null;
		try {
			// Dynamically import playwright to prevent native serialization errors in test runner
			const playwright = await import('playwright');
			browser = await playwright.chromium.launch({ headless: true });
			const context = await browser.newContext();
			const page = await context.newPage();

			await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded' });

			// Wait up to 5s for any dynamic table or game links to render
			try {
				await page.waitForSelector('a[href*="/spiele/"]', { timeout: 5000 });
			} catch (e) {
				// Fallback or warning if selector is not found immediately
				console.warn('⚠️ [BblHarvester] Timeout waiting for anchor elements containing /spiele/. Attempting evaluation anyway...');
			}

			const gameIds = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="/spiele/"]'));
				return anchors
					.map(a => a.getAttribute('href') || a.href)
					.map(url => {
						const match = url.match(/\/spiele\/([a-zA-Z0-9-]+)/i);
						return match ? match[1] : null;
					})
					.filter(Boolean);
			});

			const uniqueGameIds = [...new Set(gameIds)];
			console.log(`✅ [BblHarvester] Discovered ${uniqueGameIds.length} unique games for season ${year}.`);

			// Format into canonical slugs: matchup-Dyear_gameCode
			return uniqueGameIds.map(id => {
				return `matchup-D${year}_${id}`;
			});
		} catch (error) {
			console.error(`❌ [BblHarvester] Failed to harvest BBL calendar via Playwright:`, error.message || error);
			return [];
		} finally {
			if (browser) {
				await browser.close();
			}
		}
	}
}
export default BblHarvester;
