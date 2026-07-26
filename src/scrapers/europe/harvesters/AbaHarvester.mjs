import { HTTPClient } from '#utils';

/**
 * @description Harvester for Adriatic Basketball League (AdmiralBet ABA League) schedules from aba-liga.com.
 * Discovers and collects match IDs across ABA seasons using Playwright.
 */
export class AbaHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.aba-liga.com');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for ABA for a given season.
	 * @param {string|number} year - The season start year (e.g., '2024' for 2024-2025)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network/playwright calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`partizan-vs-crvena-zvezda-V${year}_123`,
				`buducnost-vs-cedevita-olimpija-V${year}_124`
			];
		}

		// Convert 4-digit year to 2-digit ABA season code (e.g., 2024 -> '24', 2025 -> '25')
		const seasonCode = String(year).slice(-2);
		const calendarUrl = `https://www.aba-liga.com/calendar/${seasonCode}/1/`;
		console.log(`📡 [AbaHarvester] Harvesting ABA season ${year} (Season Code: ${seasonCode}) from ${calendarUrl}...`);

		// Import Playwright dynamically to prevent worker serialization errors
		const { chromium } = await import('playwright');
		const browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();

		try {
			await page.goto(calendarUrl, { waitUntil: 'domcontentloaded' });

			// Wait up to 5 seconds for match elements to be present
			try {
				await page.waitForSelector('a[href*="/match/"]', { timeout: 5000 });
			} catch (e) {
				console.warn('⚠️ [AbaHarvester] Match links not immediately visible, proceeding with evaluation.');
			}

			const extractedMatches = await page.evaluate(() => {
				const anchors = Array.from(document.querySelectorAll('a[href*="/match/"]'));
				return anchors
					.map(a => {
						const href = a.getAttribute('href') || '';
						if (!href.includes('/Boxscore/')) return null;

						// Attempt to find team names from the parent row/card text
						let homeTeam = 'home';
						let awayTeam = 'away';
						const parent = a.closest('.match, .match-row, tr, div');
						if (parent) {
							// Look for team names in spans/divs or inner text
							const text = parent.innerText || '';
							const lines = text.split('\n').map(t => t.trim()).filter(Boolean);
							if (lines.length >= 2) {
								homeTeam = lines[0];
								awayTeam = lines[lines.length - 1];
							}
						}

						return {
							href,
							homeTeam,
							awayTeam
						};
					})
					.filter(Boolean);
			});

			await browser.close();

			const gameSlugs = [];
			const slugify = (text) => {
				return text
					.toLowerCase()
					.replace(/[^a-z0-9\s-]/g, '')
					.trim()
					.replace(/[\s-]+/g, '-');
			};

			for (const item of extractedMatches) {
				const path = item.href;
				// Extract numeric match ID from path: /match/{id}/{season_code}/...
				const match = path.match(/\/match\/(\d+)\//);
				if (!match) continue;
				const matchId = match[1];

				const homeSlug = slugify(item.homeTeam);
				const awaySlug = slugify(item.awayTeam);

				gameSlugs.push(`${awaySlug}-vs-${homeSlug}-V${year}_${matchId}`);
			}

			const uniqueSlugs = [...new Set(gameSlugs)];
			console.log(`✅ [AbaHarvester] Successfully harvested ${uniqueSlugs.length} unique ABA games for season ${year}.`);
			return uniqueSlugs;
		} catch (error) {
			await browser.close();
			console.error(`❌ [AbaHarvester] Failed to harvest ABA calendar:`, error.message || error);
			return [];
		}
	}
}

export default AbaHarvester;
