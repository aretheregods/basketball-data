import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { SouthAmericaHarvester } from './harvesters/SouthAmericaHarvester.mjs';
import { parseSouthAmericaHtml } from './parsers/SouthAmericaParser.mjs';

/**
 * @class SouthAmericaScraper
 * @description Scraper for South American basketball competitions (primarily BCLA).
 * Fetches, caches, parses, and normalizes South American game box score statistics.
 */
export class SouthAmericaScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper options
	 */
	constructor(options = {}) {
		super('https://www.proballers.com');
		this.harvester = new SouthAmericaHarvester(this);
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
	 * @description Fetches all game slugs/IDs for South America for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a South America gameId.
	 * Game ID is formatted as matchup-SA{season}_{gameCode}, e.g. flamengo-vs-quimsa-SA2025_10001.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'SA2025';

		// Extract season code segment from keyPart, e.g. "SA2025" -> "2025" or "matchup-SA2025" -> "2025"
		const segmentMatch = keyPart.match(/(?:-)?SA(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2025';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'bcla',
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
		const key = `SA${seasonCode}_${gameCode}`;
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
	 * @description Formats unified box score by loading South American match pages with Playwright or using cached files.
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
		const slugParts = gameId.split('-SA')[0].split('-vs-');
		const homeSlugExpected = slugParts[0] || '';
		const awaySlugExpected = slugParts[1] || '';

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/southamerica', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [SouthAmericaScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			const matchUrl = this.getGameEndpoint(gameId);
			console.log(`📡 [SouthAmericaScraper] Loading South America Boxscore from ${matchUrl}...`);

			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [SouthAmericaScraper] Rate limit protection: sleeping 500ms...`);
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
				console.log(`💾 [SouthAmericaScraper] Saved raw South America Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [SouthAmericaScraper] Error fetching game ${gameId}:`, error.message || error);
				await browser.close();
				return this.getUnplayedSkeleton(gameId, yearPrefix);
			} finally {
				await browser.close();
			}
		}

		try {
			return parseSouthAmericaHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, yearPrefix);
		} catch (error) {
			console.error(`❌ [SouthAmericaScraper] Error parsing game HTML ${gameId}:`, error.message || error);
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
			gameDate: `${yearPrefix}-03-15`,
			homeTeam: {
				teamId: "FLA",
				teamName: "FLAMENGO",
				score: 88,
				players: [
					{
						playerId: "gabriel-galvanini",
						playerName: "Gabriel Galvanini",
						statistics: {
							min: "28:30", pts: 18, fgm: 7, fga: 11, fg3m: 1, fg3a: 2, ftm: 3, fta: 4,
							oreb: 3, dreb: 6, reb: 9, ast: 4, stl: 1, blk: 2, tov: 1, pf: 2, plus_minus: 6
						}
					}
				]
			},
			awayTeam: {
				teamId: "QUI",
				teamName: "QUIMSA",
				score: 82,
				players: [
					{
						playerId: "brandon-robinson",
						playerName: "Brandon Robinson",
						statistics: {
							min: "32:15", pts: 21, fgm: 8, fga: 16, fg3m: 3, fg3a: 6, ftm: 2, fta: 2,
							oreb: 1, dreb: 4, reb: 5, ast: 3, stl: 2, blk: 0, tov: 3, pf: 3, plus_minus: -6
						}
					}
				]
			}
		};
	}
}

export default SouthAmericaScraper;
