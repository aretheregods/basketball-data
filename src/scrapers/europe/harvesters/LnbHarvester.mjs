/**
 * @description Harvester for LNB (French basketball) schedules using Playwright.
 */
export class LnbHarvester {
	/**
	 * @constructor
	 * @param {Object} scraperInstance - The parent scraper instance
	 */
	constructor(scraperInstance) {
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for LNB for a given season.
	 * @param {string|number} year - The season start year (e.g. 2025)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid launching Playwright
		if (process.env.NODE_ENV === 'test') {
			return [
				`asvel-vs-monaco-L${year}_22adca87_67a9_11f0_86e1_4dfdc3c87d29`,
				`paris-vs-bourg-L${year}_55bdca87_67a9_11f0_86e1_4dfdc3c87d29`
			];
		}

		const calendarUrl = `https://lnb.fr/fr/calendrier?season=${year}`;
		console.log(`📡 [LnbHarvester] Launching browser to fetch calendar from ${calendarUrl}...`);

		let browser;
		try {
			const { chromium } = await import('playwright');
			browser = await chromium.launch({ headless: true });
			const context = await browser.newContext({
				userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			});
			const page = await context.newPage();
			await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

			const gameUUIDs = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="/match-center/"]'));
				return anchors
					.map(a => a.href)
					.map(url => {
						const match = url.match(/\/match-center\/([a-f0-9-]+)/i);
						return match ? match[1] : null;
					})
					.filter(Boolean);
			});

			const uniqueUUIDs = [...new Set(gameUUIDs)];
			console.log(`✅ [LnbHarvester] Found ${uniqueUUIDs.length} unique match UUIDs.`);

			// Format slugs as matchup-Lyear_uuid (using underscores instead of hyphens in UUID for compatibility)
			return uniqueUUIDs.map(uuid => `matchup-L${year}_${uuid.replace(/-/g, '_')}`);
		} catch (error) {
			console.error(`❌ [LnbHarvester] Failed to harvest LNB calendar:`, error.message || error);
			return [];
		} finally {
			if (browser) {
				await browser.close();
			}
		}
	}
}
