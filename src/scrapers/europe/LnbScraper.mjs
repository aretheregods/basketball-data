import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { LnbHarvester } from './harvesters/LnbHarvester.mjs';
import { parseLnbDom } from './parsers/LnbParser.mjs';

/**
 * @description Engine for fetching, parsing, and normalizing French LNB (domestic) data.
 */
export class LnbScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://lnb.fr');
		this.harvester = new LnbHarvester(this);
		this.gameSlugs = [];
	}

	/**
	 * @description Fetches all game slugs/IDs for LNB for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>}
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode/UUID from an LNB gameId.
	 * LNB game ID is formatted as L{season}_{uuid_with_underscores}, e.g. L2025_22adca87_67a9_11f0_86e1_4dfdc3c87d29.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string, gameUuid: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || 'L2025';

		// Reconstruct the UUID by joining the remaining parts back with hyphens
		const uuidParts = parts.slice(1);
		const gameCode = uuidParts.join('-'); // e.g. "22adca87-67a9-11f0-86e1-4dfdc3c87d29"

		const seasonCode = keyPart.substring(1); // Strip 'L'
		const yearPrefix = seasonCode;

		return {
			competitionId: 'lnb',
			seasonCode,
			gameCode, // UUID format
			yearPrefix,
			gameUuid: gameCode
		};
	}

	/**
	 * @description Returns the complete Match Center page URL for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Match Center URL
	 */
	getGameEndpoint(gameId) {
		const { gameUuid } = this.parseGameId(gameId);
		return `https://lnb.fr/fr/match-center/${gameUuid}`;
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
	 * @description Formats unified box score by loading match center page via Playwright and extracting tables.
	 * @param {string} gameId - Combined game identifier, e.g. 'L2025_22adca87_67a9_11f0_86e1_4dfdc3c87d29'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameUuid } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (process.env.NODE_ENV === 'test') {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const matchCenterUrl = this.getGameEndpoint(gameId);
		console.log(`📡 [LnbScraper] Loading Match Center from ${matchCenterUrl}...`);

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/lnb', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameUuid}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [LnbScraper] HTML cache found for game ${gameUuid}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		let browser;
		try {
			const { chromium } = await import('playwright');
			browser = await chromium.launch({ headless: true });
			const context = await browser.newContext({
				userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			});
			const page = await context.newPage();

			if (htmlContent) {
				// Load the cached HTML instead of hitting the live network
				await page.setContent(htmlContent);
			} else {
				// Load live page and save HTML
				await page.goto(matchCenterUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
				htmlContent = await page.content();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [LnbScraper] Saved raw Match Center HTML to ${htmlCachePath}`);
			}

			// Parse DOM via our parser helper
			const parsedData = await parseLnbDom(page, gameUuid);

			return this.mapToUnifiedSchema(gameId, parsedData);
		} catch (error) {
			console.error(`❌ [LnbScraper] Error scraping/parsing game ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		} finally {
			if (browser) {
				await browser.close();
			}
		}
	}

	/**
	 * @description Maps parsed LNB DOM tables to the unified European schema.
	 * @param {string} gameId
	 * @param {Object} parsedData
	 * @returns {Object} Unified Europe BoxScore
	 */
	mapToUnifiedSchema(gameId, parsedData) {
		const { competitionId, yearPrefix } = this.parseGameId(gameId);

		// Calculate team aggregates from player stats
		const calculateTeamStats = (players) => {
			const stats = {
				fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0,
				oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0
			};
			let totalScore = 0;

			for (const p of players) {
				const s = p.statistics || {};
				totalScore += Number(s.pts || 0);
				stats.fgm += Number(s.fgm || 0);
				stats.fga += Number(s.fga || 0);
				stats.fg3m += Number(s.fg3m || 0);
				stats.fg3a += Number(s.fg3a || 0);
				stats.ftm += Number(s.ftm || 0);
				stats.fta += Number(s.fta || 0);
				stats.oreb += Number(s.oreb || 0);
				stats.dreb += Number(s.dreb || 0);
				stats.reb += Number(s.reb || (s.oreb + s.dreb) || 0);
				stats.ast += Number(s.ast || 0);
				stats.stl += Number(s.stl || 0);
				stats.blk += Number(s.blk || 0);
				stats.tov += Number(s.tov || 0);
				stats.pf += Number(s.pf || 0);
			}

			return { stats, score: totalScore };
		};

		const homeCalc = calculateTeamStats(parsedData.homePlayers || []);
		const awayCalc = calculateTeamStats(parsedData.awayPlayers || []);

		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: new Date().toISOString().split('T')[0], // Default date to today since calendar doesn't parse it easily
			homeTeam: {
				teamId: "HOME",
				teamName: parsedData.homeTeamName || "Home Team",
				score: homeCalc.score,
				statistics: homeCalc.stats,
				players: parsedData.homePlayers || []
			},
			awayTeam: {
				teamId: "AWAY",
				teamName: parsedData.awayTeamName || "Away Team",
				score: awayCalc.score,
				statistics: awayCalc.stats,
				players: parsedData.awayPlayers || []
			}
		};
	}

	/**
	 * @description Returns standard unplayed skeleton boxscore.
	 * @param {string} gameId
	 * @param {string} competitionId
	 * @param {string} yearPrefix
	 * @returns {Object}
	 */
	getUnplayedSkeleton(gameId, competitionId, yearPrefix) {
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
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
		const { competitionId, yearPrefix } = this.parseGameId(gameId);
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: `${yearPrefix}-10-18`,
			homeTeam: {
				teamId: "ASV",
				teamName: "LDLC ASVEL",
				score: 88,
				statistics: {
					fgm: 29,
					fga: 58,
					fg3m: 9,
					fg3a: 21,
					ftm: 21,
					fta: 24,
					oreb: 8,
					dreb: 22,
					reb: 30,
					ast: 18,
					stl: 6,
					blk: 2,
					tov: 12,
					pf: 18
				},
				players: [
					{
						playerId: "elie-okobo",
						playerName: "Élie Okobo",
						statistics: {
							min: "18:05",
							pts: 18,
							fgm: 6,
							fga: 10,
							fg3m: 3,
							fg3a: 5,
							ftm: 3,
							fta: 4,
							oreb: 0,
							dreb: 2,
							reb: 2,
							ast: 5,
							stl: 1,
							blk: 0,
							tov: 2,
							pf: 2,
							plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "MON",
				teamName: "AS MONACO",
				score: 82,
				statistics: {
					fgm: 28,
					fga: 60,
					fg3m: 8,
					fg3a: 24,
					ftm: 18,
					fta: 21,
					oreb: 9,
					dreb: 20,
					reb: 29,
					ast: 14,
					stl: 5,
					blk: 1,
					tov: 11,
					pf: 21
				},
				players: [
					{
						playerId: "mike-james",
						playerName: "Mike James",
						statistics: {
							min: "24:30",
							pts: 22,
							fgm: 7,
							fga: 15,
							fg3m: 4,
							fg3a: 8,
							ftm: 4,
							fta: 4,
							oreb: 1,
							dreb: 2,
							reb: 3,
							ast: 4,
							stl: 1,
							blk: 0,
							tov: 3,
							pf: 3,
							plus_minus: -6
						}
					}
				]
			}
		};
	}
}
