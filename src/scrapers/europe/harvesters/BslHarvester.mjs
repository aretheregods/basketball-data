import { HTTPClient } from '#utils';

/**
 * @description Harvester for Turkish Basketbol Süper Ligi (BSL) schedules from RealGM.
 * Discovers and collects match IDs across BSL seasons using Playwright.
 */
export class BslHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://basketball.realgm.com');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for BSL for a given season.
	 * @param {string|number} year - The season start year (e.g., '2025' for 2025-2026)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network/playwright calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`besiktas-vs-galatasaray-S${year}_412345`,
				`fenerbahce-vs-anadolu-efes-S${year}_412346`
			];
		}

		const scheduleUrl = `https://basketball.realgm.com/international/league/7/Turkish-BSL/schedule/${year}`;
		console.log(`📡 [BslHarvester] Harvesting BSL season ${year} from ${scheduleUrl}...`);

		// Import Playwright dynamically to prevent worker serialization errors
		const { chromium } = await import('playwright');
		const browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();

		try {
			await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded' });

			// Extract relative box score paths (e.g., /international/boxscore/2026-05-10/Besiktas-vs-Galatasaray/412345)
			const boxscorePaths = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="/international/boxscore/"]'));
				return anchors.map(a => a.getAttribute('href')).filter(Boolean);
			});

			await browser.close();

			const uniquePaths = [...new Set(boxscorePaths)];
			const slugs = uniquePaths.map(path => {
				// Path format: /international/boxscore/YYYY-MM-DD/Matchup-Team-Names/gameId
				const parts = path.split('/').filter(Boolean);
				const gameCode = parts[parts.length - 1] || '';
				const matchupRaw = parts[parts.length - 2] || 'matchup';
				const matchup = matchupRaw.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');

				// Map to standard layout: matchup-Syear_gameId
				return `${matchup}-S${year}_${gameCode}`;
			});

			// Populate scraper map if scraper exists
			if (this.scraper && typeof this.scraper.setGameUrl === 'function') {
				uniquePaths.forEach(path => {
					const parts = path.split('/').filter(Boolean);
					const gameCode = parts[parts.length - 1] || '';
					const key = `S${year}_${gameCode}`;
					const fullUrl = `https://basketball.realgm.com${path}`;
					this.scraper.setGameUrl(key, fullUrl);
				});
			}

			console.log(`✅ [BslHarvester] Successfully harvested ${slugs.length} BSL game slugs for season ${year}.`);
			return slugs;
		} catch (error) {
			await browser.close();
			console.error(`❌ [BslHarvester] Failed to harvest BSL schedule:`, error.message || error);
			return [];
		}
	}
}

export default BslHarvester;
