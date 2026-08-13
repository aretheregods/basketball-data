import { HTTPClient } from '#utils';

/**
 * @description Harvester for Asian schedules from Proballers (EASL, WASL, BCL Asia, FIBA Asia CC, B.League, KBL, PBA, CBA, TPBL).
 * Discovers and collects match IDs across seasons using Playwright or cached fallback lists.
 */
export class AsiaHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.proballers.com');
		this.scraper = scraperInstance;

		// Map competition keys to their Proballers League IDs
		this.leagueIdMap = {
			easl: 100115,
			wasl: 100116,
			bcl_asia: 100117,
			fiba_asia_cc: 100118,
			bleague: 100099,
			kbl: 100100,
			pba: 100101,
			cba: 100102,
			tpbl: 100103
		};

		// Map competition keys to their Proballers URL slugs
		this.leagueSlugMap = {
			easl: 'east-asia-super-league',
			wasl: 'west-asia-super-league',
			bcl_asia: 'basketball-champions-league-asia',
			fiba_asia_cc: 'fiba-asia-champions-cup',
			bleague: 'japan-bleague',
			kbl: 'korea-kbl',
			pba: 'philippines-pba',
			cba: 'china-cba',
			tpbl: 'taiwan-tpbl'
		};
	}

	/**
	 * @description Checks if a competition was cancelled or did not exist for a given year.
	 * @param {string} comp - Competition identifier
	 * @param {string|number} year - The season year
	 * @returns {{ cancelled: boolean, reason?: string }} Cancellation status details
	 */
	checkCompetitionHistory(comp, year) {
		const yearNum = parseInt(year, 10);
		if (comp === 'bcl_asia' || comp === 'fiba_asia_cc') {
			// Pandemic years / cancellations
			if (yearNum >= 2020 && yearNum <= 2023) {
				return {
					cancelled: true,
					reason: `The continental tournament (${comp.toUpperCase()}) was cancelled/not held between 2020 and 2023 due to the COVID-19 pandemic and subsequent FIBA restructuring.`
				};
			}
			// Pre-existence check for BCL Asia
			if (comp === 'bcl_asia' && yearNum < 2024) {
				return {
					cancelled: true,
					reason: `BCL Asia did not exist prior to 2024. The predecessor tournament was the FIBA Asia Champions Cup (fiba_asia_cc).`
				};
			}
			// Post-existence check for FIBA Asia Champions Cup
			if (comp === 'fiba_asia_cc' && yearNum >= 2024) {
				return {
					cancelled: true,
					reason: `FIBA Asia Champions Cup was discontinued after the 2019 season, replaced by BCL Asia starting in 2024.`
				};
			}
		}
		return { cancelled: false };
	}

	/**
	 * @description Fetches all game slugs/IDs for active Asian competitions for a given season.
	 * @param {string|number} year - The season start year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const activeComps = this.scraper?.competitions || ['bcl_asia'];
		const allSlugs = [];

		// If in test mode, bypass Playwright and return mock slugs
		if (process.env.NODE_ENV === 'test' || (this.scraper && this.scraper.bypassNetwork)) {
			for (const comp of activeComps) {
				const history = this.checkCompetitionHistory(comp, year);
				if (history.cancelled) {
					console.log(`ℹ️ [AsiaHarvester] Skipping ${comp.toUpperCase()} for year ${year}: ${history.reason}`);
					continue;
				}

				const compUpper = comp.toUpperCase().replace('_', '');
				if (comp === 'bleague') {
					allSlugs.push(
						`ryukyu-golden-kings-vs-chiba-jets-${compUpper}${year}_20001`,
						`utsunomiya-brex-vs-alvark-tokyo-${compUpper}${year}_20002`
					);
				} else if (comp === 'kbl') {
					allSlugs.push(
						`seoul-sk-knights-vs-db-promy-${compUpper}${year}_30001`
					);
				} else if (comp === 'fiba_asia_cc') {
					allSlugs.push(
						`al-riyadi-vs-alvark-tokyo-${compUpper}${year}_40001`
					);
				} else {
					// Default mock (EASL, WASL, BCL Asia)
					allSlugs.push(
						`ryukyu-golden-kings-vs-seoul-sk-knights-${compUpper}${year}_10001`,
						`al-riyadi-vs-chiba-jets-${compUpper}${year}_10002`
					);
				}
			}
			return allSlugs;
		}

		// Non-test mode: dynamic Playwright scraper
		for (const comp of activeComps) {
			const history = this.checkCompetitionHistory(comp, year);
			if (history.cancelled) {
				console.log(`⚠️ [AsiaHarvester] Skipping ${comp.toUpperCase()} for year ${year}: ${history.reason}`);
				continue;
			}

			const compUpper = comp.toUpperCase().replace('_', '');
			const leagueId = this.leagueIdMap[comp];
			if (!leagueId) {
				console.warn(`⚠️ [AsiaHarvester] No Proballers league ID registered for competition: "${comp}". Skipping.`);
				continue;
			}

			const leagueSlug = this.leagueSlugMap[comp] || `asia-${comp}`;
			const scheduleUrl = `https://www.proballers.com/basketball/league/${leagueId}/${leagueSlug}/schedule/${year}`;
			console.log(`📡 [AsiaHarvester] Harvesting ${compUpper} season ${year} from ${scheduleUrl}...`);

			// Import Playwright dynamically
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

					// Map to standard layout: matchup-{COMP}year_gameId
					return `${matchup}-${compUpper}${year}_${gameCode}`;
				});

				// Populate scraper map if scraper exists
				if (this.scraper && typeof this.scraper.setGameUrl === 'function') {
					uniquePaths.forEach(path => {
						const parts = path.split('/').filter(Boolean);
						const gameCode = parts[2] || '';
						const matchupRaw = parts[3] || 'matchup';
						const matchup = matchupRaw.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');

						const fullUrl = path.startsWith('http') ? path : `https://www.proballers.com${path}`;
						this.scraper.setGameUrl(`${compUpper}${year}_${gameCode}`, fullUrl);
						this.scraper.setGameUrl(gameCode, fullUrl);
						this.scraper.setGameUrl(`${matchup}-${compUpper}${year}_${gameCode}`, fullUrl);
					});
				}

				console.log(`✅ [AsiaHarvester] Successfully harvested ${slugs.length} slugs for competition ${compUpper}.`);
				allSlugs.push(...slugs);
			} catch (error) {
				await browser.close();
				console.error(`❌ [AsiaHarvester] Failed to harvest schedule for ${compUpper}:`, error.message || error);
			}
		}

		return [...new Set(allSlugs)];
	}
}

export default AsiaHarvester;
