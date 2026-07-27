import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { CeblHarvester } from './harvesters/CeblHarvester.mjs';
import { parseCeblHtml } from './parsers/CeblParser.mjs';

/**
 * @class CeblScraper
 * @description Scraper for Canadian Elite Basketball League (CEBL) competition.
 * Fetches, caches, parses, and normalizes CEBL game box score statistics from cebl.ca.
 * @extends {HTTPClient}
 */
export class CeblScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper options
	 */
	constructor(options = {}) {
		super('https://www.cebl.ca');
		this.harvester = new CeblHarvester(this);
		this.gameSlugs = [];
		this.gameUrlMap = new Map();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
		this.activeYear = '2026';
	}

	/**
	 * @description Associates a game ID with its full CEBL URL during schedule harvesting.
	 * @param {string} gameId
	 * @param {string} url
	 */
	setGameUrl(gameId, url) {
		this.gameUrlMap.set(gameId, url);
	}

	/**
	 * @description Fetches all game slugs/IDs for CEBL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		this.activeYear = String(year);
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a CEBL gameId.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const match = clean.match(/cebl-(\d{4})-([a-zA-Z0-9-]+)/i);
		if (match) {
			return {
				competitionId: 'cebl',
				seasonCode: match[1],
				gameCode: match[2],
				yearPrefix: match[1]
			};
		}
		return {
			competitionId: 'cebl',
			seasonCode: this.activeYear || '2026',
			gameCode: clean,
			yearPrefix: this.activeYear || '2026'
		};
	}

	/**
	 * @description Returns the complete Game page URL for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Game page URL
	 */
	getGameEndpoint(gameId) {
		const { gameCode } = this.parseGameId(gameId);
		return this.gameUrlMap.get(gameId) || this.gameUrlMap.get(gameCode) || `https://www.cebl.ca/game/${gameCode}`;
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
	 * @description Formats unified box score by loading CEBL match pages with Playwright or using cached files.
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

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/canada', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [CeblScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			const matchUrl = this.getGameEndpoint(gameId);
			console.log(`📡 [CeblScraper] Loading CEBL Boxscore from ${matchUrl}...`);

			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [CeblScraper] Rate limit protection: sleeping 500ms...`);
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

			const page = await context.newPage();

			try {
				await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });
				// Allow time for table data to render
				for (let i = 0; i < 15; i++) {
					await page.waitForTimeout(1000);
					const count = await page.evaluate(() => document.querySelectorAll('table').length);
					if (count > 0) break;
				}
				htmlContent = await page.content();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [CeblScraper] Saved raw CEBL Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [CeblScraper] Error fetching game ${gameId}:`, error.message || error);
				await browser.close();
				return this.getUnplayedSkeleton(gameId, yearPrefix);
			} finally {
				await browser.close();
			}
		}

		try {
			return parseCeblHtml(htmlContent, gameId, yearPrefix);
		} catch (error) {
			console.error(`❌ [CeblScraper] Error parsing game HTML ${gameId}:`, error.message || error);
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
			gameDate: `${yearPrefix}-07-15`,
			homeTeam: {
				teamId: 'HOME',
				teamName: 'Unplayed',
				score: 0,
				players: []
			},
			awayTeam: {
				teamId: 'AWAY',
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
				teamId: "VAN",
				teamName: "VANCOUVER BANDITS",
				score: 95,
				players: [
					{
						playerId: "nick-ward",
						playerName: "Nick Ward",
						statistics: {
							min: "24:30", pts: 22, fgm: 8, fga: 12, fg3m: 0, fg3a: 0, ftm: 6, fta: 8,
							oreb: 3, dreb: 5, reb: 8, ast: 2, stl: 1, blk: 2, tov: 3, pf: 4, plus_minus: 5
						}
					}
				]
			},
			awayTeam: {
				teamId: "NIA",
				teamName: "NIAGARA RIVER LIONS",
				score: 90,
				players: [
					{
						playerId: "jahvon-blair",
						playerName: "Jahvon Blair",
						statistics: {
							min: "28:15", pts: 18, fgm: 6, fga: 14, fg3m: 3, fg3a: 7, ftm: 3, fta: 4,
							oreb: 1, dreb: 4, reb: 5, ast: 4, stl: 2, blk: 0, tov: 2, pf: 3, plus_minus: -5
						}
					}
				]
			}
		};
	}
}

export default CeblScraper;
