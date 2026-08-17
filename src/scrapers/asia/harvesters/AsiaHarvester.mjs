import { HTTPClient } from '#utils';

/**
 * @description Harvester for Asian schedules from Proballers (CBA, B.League, PBA, IBL, QBL, BCL Asia, FIBA Asia CC, EASL, WASL, etc.).
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

		// Map competition keys to their true Proballers League IDs
		this.leagueIdMap = {
			cba: 159,
			bleague: 281,
			pba: 357,
			ibl: 100147,
			qbl: 100118,
			asiacup: 100128,
			asiacup_qualifiers: 100106,
			bcl_asia: 100128,
			fiba_asia_cc: 100128,
			easl: 100128,
			wasl: 100128,
			kbl: 281,
			tpbl: 281
		};

		// Map competition keys to their true Proballers URL slugs
		this.leagueSlugMap = {
			cba: 'china-cba',
			bleague: 'japan-b1-league',
			pba: 'philippines-pba',
			ibl: 'indonesia-ibl',
			qbl: 'qatar-qbl',
			asiacup: 'asiacup',
			asiacup_qualifiers: 'asiacup-qualifiers',
			bcl_asia: 'asiacup',
			fiba_asia_cc: 'asiacup',
			easl: 'asiacup',
			wasl: 'asiacup',
			kbl: 'japan-b1-league',
			tpbl: 'japan-b1-league'
		};
	}

	/**
	 * @description Resolves the actual competition key to harvest based on historical branding changes.
	 * BCL Asia was launched in 2024; its predecessor was the FIBA Asia Champions Cup (fiba_asia_cc).
	 * @param {string} comp - Requested competition key
	 * @param {string|number} year - Target season year
	 * @returns {{ resolvedComp: string, isCancelled: boolean, reason?: string, mappedNotice?: string }}
	 */
	resolveTargetCompetition(comp, year) {
		const yearNum = parseInt(year, 10);

		// Handle continental Asian tournaments (BCL Asia & FIBA Asia Champions Cup)
		if (comp === 'bcl_asia' || comp === 'fiba_asia_cc') {
			// Pandemic cancellation gap (2020-2023)
			if (yearNum >= 2020 && yearNum <= 2023) {
				return {
					resolvedComp: comp,
					isCancelled: true,
					reason: `The Asian continental tournament was not held between 2020 and 2023 due to the COVID-19 pandemic and FIBA tournament restructuring.`
				};
			}

			// Pre-2024: auto-route BCL Asia requests to predecessor FIBA Asia Champions Cup
			if (comp === 'bcl_asia' && yearNum < 2024) {
				return {
					resolvedComp: 'fiba_asia_cc',
					isCancelled: false,
					mappedNotice: `Auto-routed bcl_asia for year ${year} to predecessor tournament FIBA Asia Champions Cup (fiba_asia_cc).`
				};
			}

			// Post-2023: auto-route FIBA Asia Champions Cup requests to successor BCL Asia
			if (comp === 'fiba_asia_cc' && yearNum >= 2024) {
				return {
					resolvedComp: 'bcl_asia',
					isCancelled: false,
					mappedNotice: `Auto-routed fiba_asia_cc for year ${year} to successor tournament BCL Asia (bcl_asia).`
				};
			}
		}

		return {
			resolvedComp: comp,
			isCancelled: false
		};
	}

	/**
	 * @description Legacy backward-compatibility wrapper checking competition status.
	 * @param {string} comp - Competition identifier
	 * @param {string|number} year - Season year
	 * @returns {{ cancelled: boolean, reason?: string }}
	 */
	checkCompetitionHistory(comp, year) {
		const res = this.resolveTargetCompetition(comp, year);
		return { cancelled: res.isCancelled, reason: res.reason };
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
			for (const rawComp of activeComps) {
				const { resolvedComp, isCancelled, reason, mappedNotice } = this.resolveTargetCompetition(rawComp, year);

				if (isCancelled) {
					console.log(`ℹ️ [AsiaHarvester] Skipping ${rawComp.toUpperCase()} for year ${year}: ${reason}`);
					continue;
				}

				if (mappedNotice) {
					console.log(`🔄 [AsiaHarvester] ${mappedNotice}`);
				}

				const comp = resolvedComp;
				const compUpper = comp.toUpperCase().replace(/_/g, '');

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
					// Default mock (EASL, WASL, BCL Asia, CBA, etc.)
					allSlugs.push(
						`ryukyu-golden-kings-vs-seoul-sk-knights-${compUpper}${year}_10001`,
						`al-riyadi-vs-chiba-jets-${compUpper}${year}_10002`
					);
				}
			}
			return allSlugs;
		}

		// Non-test mode: dynamic Playwright scraper
		for (const rawComp of activeComps) {
			const { resolvedComp, isCancelled, reason, mappedNotice } = this.resolveTargetCompetition(rawComp, year);

			if (isCancelled) {
				console.log(`⚠️ [AsiaHarvester] Skipping ${rawComp.toUpperCase()} for year ${year}: ${reason}`);
				continue;
			}

			if (mappedNotice) {
				console.log(`🔄 [AsiaHarvester] ${mappedNotice}`);
			}

			const comp = resolvedComp;
			const compUpper = comp.toUpperCase().replace(/_/g, '');
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
				let gamePaths = await page.evaluate(() => {
					const anchors = Array.from(document.querySelectorAll('a[href*="/basketball/game/"]'));
					return anchors.map(a => a.getAttribute('href')).filter(Boolean);
				});

				// Fallback to base schedule URL if year-specific endpoint returned 0 links
				if (gamePaths.length === 0) {
					const fallbackUrl = `https://www.proballers.com/basketball/league/${leagueId}/${leagueSlug}/schedule`;
					console.log(`🔄 [AsiaHarvester] 0 links found on year URL. Trying base schedule URL: ${fallbackUrl}`);
					await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' });
					for (let i = 0; i < 10; i++) {
						await page.waitForTimeout(1000);
						const count = await page.evaluate(() => document.querySelectorAll('a[href*="/basketball/game/"]').length);
						if (count > 0) break;
					}
					gamePaths = await page.evaluate(() => {
						const anchors = Array.from(document.querySelectorAll('a[href*="/basketball/game/"]'));
						return anchors.map(a => a.getAttribute('href')).filter(Boolean);
					});
				}

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
