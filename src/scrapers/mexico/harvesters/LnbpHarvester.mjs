import { HTTPClient } from '#utils';

/**
 * @description Harvester for Mexican LNBP schedules from Proballers.
 * Discovers and collects match IDs across LNBP seasons using Playwright.
 */
export class LnbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.proballers.com');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for LNBP for a given season.
	 * @param {string|number} year - The season start year (e.g., '2025' for 2025-2026)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network/playwright calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`fuerza-regia-vs-astros-de-jalisco-M${year}_890123`,
				`soles-de-mexicali-vs-dorados-de-chihuahua-M${year}_890124`
			];
		}

		// Proballers Mexican LNBP league ID is 166
		const scheduleUrl = `https://www.proballers.com/basketball/league/166/mexico-lnbp/schedule/${year}`;
		console.log(`📡 [LnbpHarvester] Harvesting LNBP season ${year} from ${scheduleUrl}...`);

		// Import Playwright dynamically to prevent worker serialization errors
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

		await context.addInitScript(() => {
			Object.defineProperty(navigator, 'webdriver', { get: () => false });
			Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
			Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
		});

		const page = await context.newPage();

		try {
			await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded' });

			// Wait up to 15 seconds for Cloudflare challenge completion and link rendering
			for (let i = 0; i < 15; i++) {
				await page.waitForTimeout(1000);
				const count = await page.evaluate(() => document.querySelectorAll('a[href*="/basketball/game/"]').length);
				if (count > 0) break;
			}

			// Collect all match page links from the schedule table
			const gamePaths = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="/basketball/game/"]'));
				return anchors.map(a => a.getAttribute('href')).filter(Boolean);
			});

			await browser.close();

			const uniquePaths = [...new Set(gamePaths)];
			const slugs = uniquePaths.map(path => {
				// Path format: /basketball/game/{game_id}/{matchup}
				const parts = path.split('/').filter(Boolean);
				const gameCode = parts[2] || '';
				const matchupRaw = parts[3] || 'matchup';
				const matchup = matchupRaw.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');

				// Map to standard layout: matchup-Myear_gameId
				return `${matchup}-M${year}_${gameCode}`;
			});

			// Populate scraper map if scraper exists
			if (this.scraper && typeof this.scraper.setGameUrl === 'function') {
				uniquePaths.forEach(path => {
					const parts = path.split('/').filter(Boolean);
					const gameCode = parts[2] || '';
					const matchupRaw = parts[3] || 'matchup';
					const matchup = matchupRaw.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');

					const fullUrl = path.startsWith('http') ? path : `https://www.proballers.com${path}`;
					this.scraper.setGameUrl(`M${year}_${gameCode}`, fullUrl);
					this.scraper.setGameUrl(gameCode, fullUrl);
					this.scraper.setGameUrl(`${matchup}-M${year}_${gameCode}`, fullUrl);
				});
			}

			console.log(`✅ [LnbpHarvester] Successfully harvested ${slugs.length} LNBP game slugs for season ${year}.`);
			return slugs;
		} catch (error) {
			await browser.close();
			console.error(`❌ [LnbpHarvester] Failed to harvest LNBP schedule:`, error.message || error);
			return [];
		}
	}
}

export default LnbpHarvester;
