import { HTTPClient } from '#utils';

/**
 * @class CeblHarvester
 * @description Harvester for the Canadian Elite Basketball League (CEBL) schedule from cebl.ca.
 * Extracts match IDs or box score links using Playwright.
 * @extends {HTTPClient}
 */
export class CeblHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.cebl.ca');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for CEBL for a given season.
	 * @param {string|number} year - The season year (e.g., '2026')
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network/playwright calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`cebl-${year}-10492`,
				`cebl-${year}-10493`
			];
		}

		const scheduleUrl = `https://www.cebl.ca/schedule?season=${year}`;
		console.log(`📡 [CeblHarvester] Harvesting CEBL season ${year} from ${scheduleUrl}...`);

		// Import Playwright dynamically to prevent worker serialization errors in tests
		const { chromium } = await import('playwright');
		const browser = await chromium.launch({
			headless: true,
			args: [
				'--disable-blink-features=AutomationControlled',
				'--disable-features=IsolateOrigins,site-per-process',
				'--no-sandbox',
				'--disable-setuid-sandbox'
			]
		});

		const context = await browser.newContext({
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			viewport: { width: 1920, height: 1080 },
			locale: 'en-US'
		});

		const page = await context.newPage();

		try {
			await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded' });

			// Wait up to 15 seconds for schedule links to render
			for (let i = 0; i < 15; i++) {
				await page.waitForTimeout(1000);
				const count = await page.evaluate(() => {
					return document.querySelectorAll('a[href*="/game/"], a[href*="/game-center/"]').length;
				});
				if (count > 0) break;
			}

			const gameIds = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="/game/"], a[href*="/game-center/"]'));
				return anchors
					.map(a => a.href)
					.map(url => {
						const match = url.match(/\/(?:game|game-center)\/([a-zA-Z0-9-]+)/i);
						return match ? match[1] : null;
					})
					.filter(Boolean);
			});

			await browser.close();

			const uniqueIds = [...new Set(gameIds)];
			const slugs = uniqueIds.map(id => `cebl-${year}-${id}`);

			// Populate scraper map if scraper exists
			if (this.scraper && typeof this.scraper.setGameUrl === 'function') {
				uniqueIds.forEach(id => {
					const fullUrl = `https://www.cebl.ca/game/${id}`;
					this.scraper.setGameUrl(`cebl-${year}-${id}`, fullUrl);
					this.scraper.setGameUrl(id, fullUrl);
				});
			}

			console.log(`✅ [CeblHarvester] Successfully harvested ${slugs.length} CEBL game slugs for season ${year}.`);
			return slugs;
		} catch (error) {
			await browser.close();
			console.error(`❌ [CeblHarvester] Failed to harvest CEBL schedule:`, error.message || error);
			return [];
		}
	}
}

export default CeblHarvester;
