import { HTTPClient } from '#utils';

/**
 * @description Harvester for Israeli Basketball (Winner League / Ligat Ha'Al) schedules from basket.co.il.
 * Discovers and collects match IDs across seasons.
 */
export class IsraeliHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.basket.co.il');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for Israeli League for a given season.
	 * @param {string|number} year - The season start year (e.g., '2025' for 2024-2025 or similar)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network/playwright calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`maccabi-playtika-tel-aviv-vs-hapoel-bank-yahav-jerusalem-Y${year}_25237`,
				`ironi-lati-kiryat-ata-vs-hapoel-afula-Y${year}_25147`
			];
		}

		const scheduleUrl = `https://www.basket.co.il/results.asp?cYear=${year}&lang=en`;
		console.log(`📡 [IsraeliHarvester] Harvesting Israeli League season ${year} from ${scheduleUrl}...`);

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

			// Wait up to 10 seconds for game-zone links to render
			for (let i = 0; i < 10; i++) {
				await page.waitForTimeout(1000);
				const count = await page.evaluate(() => document.querySelectorAll('a[href*="GameId="]').length);
				if (count > 0) break;
			}

			// Extract all game-zone links and their inner img alt matchup tags
			const gamesData = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="game-zone.asp"], a[href*="GameId="]'));
				return anchors.map(a => {
					const href = a.getAttribute('href') || '';
					const img = a.querySelector('img');
					const alt = img ? img.getAttribute('alt') : '';
					return { href, alt };
				}).filter(g => g.href.toUpperCase().includes('GAMEID='));
			});

			await browser.close();

			const slugify = (text) => {
				return String(text || '')
					.toLowerCase()
					.replace(/[^a-z0-9\s-]/g, '')
					.trim()
					.replace(/[\s-]+/g, '-');
			};

			const gameSlugsMap = new Map();

			for (const game of gamesData) {
				const match = game.href.match(/GameId=(\d+)/i);
				if (match) {
					const gameCode = match[1];
					let matchup = 'matchup';
					if (game.alt) {
						// e.g. "Ironi Lati Kiryat Ata Vs Hapoel Afula" -> "ironi-lati-kiryat-ata-vs-hapoel-afula"
						matchup = game.alt.toLowerCase().replace(/\s+vs\s+/i, '-vs-');
						matchup = slugify(matchup);
					}
					const key = `${matchup}-Y${year}_${gameCode}`;
					gameSlugsMap.set(gameCode, key);
				}
			}

			const slugs = Array.from(gameSlugsMap.values());
			console.log(`✅ [IsraeliHarvester] Successfully harvested ${slugs.length} Israeli League game slugs for season ${year}.`);
			return slugs;
		} catch (error) {
			await browser.close();
			console.error(`❌ [IsraeliHarvester] Failed to harvest Israeli League schedule:`, error.message || error);
			return [];
		}
	}
}

export default IsraeliHarvester;
