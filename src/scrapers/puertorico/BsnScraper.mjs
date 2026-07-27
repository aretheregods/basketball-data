import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { BsnHarvester } from './harvesters/BsnHarvester.mjs';
import { parseBsnHtml } from './parsers/BsnParser.mjs';

/**
 * @class BsnScraper
 * @description Scraper for Puerto Rico Baloncesto Superior Nacional (BSN) competition.
 * Fetches, caches, parses, and normalizes BSN game box score statistics from Proballers.
 */
export class BsnScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper options
	 */
	constructor(options = {}) {
		super('https://www.proballers.com');
		this.harvester = new BsnHarvester(this);
		this.gameSlugs = [];
		this.gameUrlMap = new Map();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Associates a game ID with its full Proballers URL during schedule harvesting.
	 * @param {string} gameId
	 * @param {string} url
	 */
	setGameUrl(gameId, url) {
		this.gameUrlMap.set(gameId, url);
	}

	/**
	 * @description Fetches all game slugs/IDs for BSN for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a BSN gameId.
	 * BSN game ID is formatted as matchup-B{season}_{gameCode}, e.g. vaqueros-vs-capitanes-B2026_123456.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'B2025';

		// Extract season code segment from keyPart, e.g. "B2025" -> "2025" or "matchup-B2025" -> "2025"
		const segmentMatch = keyPart.match(/(?:-)?B(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2025';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'bsn',
			seasonCode,
			gameCode,
			yearPrefix
		};
	}

	/**
	 * @description Returns the complete Game page URL for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Game page URL
	 */
	getGameEndpoint(gameId) {
		const { gameCode, seasonCode } = this.parseGameId(gameId);
		const key = `B${seasonCode}_${gameCode}`;
		return this.gameUrlMap.get(key) || this.gameUrlMap.get(gameId) || this.gameUrlMap.get(gameCode) || `https://www.proballers.com/basketball/game/${gameCode}/matchup`;
	}

	/**
	 * @description Returns the game ID itself.
	 * @param {string} gameId
	 * @returns {string}
	 */
	getGameUrl(gameId) {
		return gameId;
	}

	/**
	 * @description Formats unified box score by loading BSN match pages with Playwright or using cached files.
	 * @param {string} url - Game ID
	 * @param {Object} [options]
	 * @param {number} [retries]
	 * @param {number} [delay]
	 * @returns {Promise<Object>} Cleaned and structured box score object
	 */
	async request(url, options = {}, retries = 3, delay = 1000) {
		const gameId = url;
		const { yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Parse matchup team names from the gameId slug for mapping
		const slugParts = gameId.split('-B')[0].split('-vs-');
		const homeSlugExpected = slugParts[0] || '';
		const awaySlugExpected = slugParts[1] || '';

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/puertorico', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`箱 [BsnScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			const matchUrl = this.getGameEndpoint(gameId);
			console.log(`📡 [BsnScraper] Loading BSN Boxscore from ${matchUrl}...`);

			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [BsnScraper] Rate limit protection: sleeping 500ms...`);
			await new Promise(resolve => setTimeout(resolve, 500));

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
				await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });
				// Allow time for Cloudflare challenge / table data to render
				for (let i = 0; i < 15; i++) {
					await page.waitForTimeout(1000);
					const count = await page.evaluate(() => document.querySelectorAll('table').length);
					if (count > 0) break;
				}
				htmlContent = await page.content();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [BsnScraper] Saved raw BSN Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [BsnScraper] Error fetching game ${gameId}:`, error.message || error);
				await browser.close();
				return this.getUnplayedSkeleton(gameId, yearPrefix);
			} finally {
				await browser.close();
			}
		}

		try {
			return parseBsnHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, yearPrefix);
		} catch (error) {
			console.error(`❌ [BsnScraper] Error parsing game HTML ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, yearPrefix);
		}
	}

	/**
	 * @description Returns standard unplayed skeleton boxscore.
	 * @param {string} gameId
	 * @param {string} yearPrefix
	 * @returns {Object}
	 */
	getUnplayedSkeleton(gameId, yearPrefix) {
		return {
			gameId,
			season: yearPrefix,
			gameDate: '',
			homeTeam: {
				teamId: '',
				teamName: 'Unplayed',
				score: 0,
				players: []
			},
			awayTeam: {
				teamId: '',
				teamName: 'Unplayed',
				score: 0,
				players: []
			}
		};
	}

	/**
	 * @description Generates mock data for fallback / testing.
	 * @param {string} gameId
	 * @returns {Object}
	 */
	getMockUnifiedBoxScore(gameId) {
		const { yearPrefix } = this.parseGameId(gameId);
		return {
			gameId,
			season: yearPrefix,
			gameDate: `${yearPrefix}-07-15`,
			homeTeam: {
				teamId: "BAY",
				teamName: "VAQUEROS DE BAYAMON",
				score: 95,
				players: [
					{
						playerId: "tremont-waters",
						playerName: "Tremont Waters",
						statistics: {
							min: "24:30", pts: 22, fgm: 8, fga: 12, fg3m: 2, fg3a: 4, ftm: 4, fta: 4,
							oreb: 1, dreb: 4, reb: 5, ast: 6, stl: 2, blk: 0, tov: 2, pf: 3, plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "ARE",
				teamName: "CAPITANES DE ARECIBO",
				score: 90,
				players: [
					{
						playerId: "angel-rodriguez",
						playerName: "Ángel Rodríguez",
						statistics: {
							min: "28:15", pts: 18, fgm: 6, fga: 14, fg3m: 3, fg3a: 7, ftm: 3, fta: 4,
							oreb: 1, dreb: 4, reb: 5, ast: 4, stl: 2, blk: 0, tov: 2, pf: 3, plus_minus: -8
						}
					}
				]
			}
		};
	}
}

export default BsnScraper;
