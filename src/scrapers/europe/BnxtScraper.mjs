import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { BnxtHarvester } from './harvesters/BnxtHarvester.mjs';

/**
 * @description Scraper for BNXT League (Belgium & Netherlands domestic basketball league).
 * Fetches, caches, parses, and normalizes BNXT game box score statistics from bnxt.sportpress.info API.
 */
export class BnxtScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://bnxt.sportpress.info');
		this.harvester = new BnxtHarvester(this);
		this.gameSlugs = [];
		this.gameMetadataMap = new Map();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
		this.apiToken = process.env.BNXT_API_TOKEN || 'BWSyE7sgg9QAurh2JX9cpjzjGc652BWLuNUS';
	}

	/**
	 * @description Associates metadata (like numeric competitionId) with a game.
	 * @param {string} gameId
	 * @param {Object} metadata
	 */
	setGameMetadata(gameId, metadata) {
		this.gameMetadataMap.set(String(gameId), metadata);
	}

	/**
	 * @description Fetches all game slugs/IDs for BNXT League for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a BNXT gameId.
	 * BNXT game ID is formatted as matchup-N{season}_{gameCode}, e.g. filou-oostende-vs-spirou-basket-N2024_7161.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'N2024';

		// Extract season code segment from keyPart, e.g. "N2024" -> "2024" or "matchup-N2024" -> "2024"
		const segmentMatch = keyPart.match(/(?:-)?N(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2024';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'bnxt',
			seasonCode,
			gameCode,
			yearPrefix
		};
	}

	/**
	 * @description Returns the complete Game page URL or API endpoint for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Game URL
	 */
	getGameEndpoint(gameId) {
		const { gameCode } = this.parseGameId(gameId);
		return `https://bnxtleague.com/en/game/${gameCode}`;
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
	 * @description Resolves internal competition integer ID from season year (e.g. 2024 -> 12, 2025 -> 22, 2023 -> 3, 2022 -> 1).
	 * @param {string|number} year
	 * @returns {Promise<number>}
	 */
	async resolveCompetitionId(year) {
		const targetYear = String(year);
		const known = {
			'2022': 1,
			'2023': 3,
			'2024': 12,
			'2025': 22,
			'2026': 24
		};
		if (known[targetYear]) return known[targetYear];

		try {
			const headers = {
				'X-Authorization': this.apiToken,
				'Content-Type': 'application/json',
				'X-Localization': 'en'
			};
			const res = await fetch(`https://bnxt.sportpress.info/api/v1/phase/season/${targetYear}?lang=en`, { headers });
			if (res.ok) {
				const json = await res.json();
				const comp = json.data?.[0]?.competition;
				if (comp?.id) return comp.id;
			}
		} catch (e) {
			// fallback
		}
		return 12;
	}

	/**
	 * @description Formats unified box score by loading BNXT match data from API or side-cache.
	 * @param {string} gameId - Combined game identifier, e.g. 'filou-oostende-vs-spirou-basket-N2024_7161'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Set up directories for side-cache JSON saving
		const jsonCacheDir = path.resolve('data/raw/europe/bnxt', String(yearPrefix));
		await fs.mkdir(jsonCacheDir, { recursive: true });
		const jsonCachePath = path.join(jsonCacheDir, `${gameCode}.json`);

		let cachedContent = '';
		try {
			const stats = await fs.stat(jsonCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [BnxtScraper] JSON cache found for game ${gameCode}. Reading from disk...`);
				cachedContent = await fs.readFile(jsonCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (cachedContent) {
			try {
				return JSON.parse(cachedContent);
			} catch (e) {
				// Corrupt cache, refetch
			}
		}

		try {
			const headers = {
				'X-Authorization': this.apiToken,
				'Content-Type': 'application/json',
				'X-Localization': 'en'
			};

			// Determine competition numeric ID
			let numericCompId = this.gameMetadataMap.get(String(gameCode))?.competitionId;
			if (!numericCompId) {
				numericCompId = await this.resolveCompetitionId(yearPrefix);
			}

			// 1. Fetch game details from schedule/find endpoint to get scores and dates
			let scheduleItem = this.gameMetadataMap.get(String(gameCode))?.gameData;
			if (!scheduleItem) {
				const schedRes = await fetch(`https://bnxt.sportpress.info/api/v1/schedule/find/${gameCode}?lang=en`, { headers });
				if (schedRes.ok) {
					const schedJson = await schedRes.json();
					scheduleItem = schedJson.data;
				}
			}

			// 2. Fetch box score from API
			const boxUrl = `https://bnxt.sportpress.info/api/v1/boxscore/game/${numericCompId}/${gameCode}?lang=en`;
			console.log(`📡 [BnxtScraper] Loading BNXT Boxscore from ${boxUrl}...`);

			const boxRes = await fetch(boxUrl, { headers });
			if (!boxRes.ok) {
				throw new Error(`HTTP Error fetching boxscore API: ${boxRes.status} ${boxRes.statusText}`);
			}
			const boxJson = await boxRes.json();
			const teamBlocks = boxJson.data || [];

			if (teamBlocks.length < 2) {
				throw new Error(`Invalid BNXT boxscore: received fewer than 2 teams for game ${gameCode}`);
			}

			return this.parseBnxtPayload(teamBlocks, scheduleItem, gameId, competitionId, yearPrefix, jsonCachePath);
		} catch (error) {
			console.error(`❌ [BnxtScraper] Error parsing game ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Parses BNXT API team blocks and schedule item into unified schema.
	 * @param {Object[]} teamBlocks
	 * @param {Object} [scheduleItem]
	 * @param {string} gameId
	 * @param {string} competitionId
	 * @param {string} yearPrefix
	 * @param {string} jsonCachePath
	 * @returns {Promise<Object>}
	 */
	async parseBnxtPayload(teamBlocks, scheduleItem, gameId, competitionId, yearPrefix, jsonCachePath) {
		const cleanTeamName = (name) => {
			return String(name || '')
				.replace(/playoff/gi, '')
				.replace(/\s+/g, ' ')
				.trim();
		};

		const slugify = (text) => {
			return String(text || '')
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, '')
				.trim()
				.replace(/[\s-]+/g, '-');
		};

		// Helper to map players
		const mapPlayers = (rawPlayers) => {
			return (rawPlayers || []).map(p => {
				const playerObj = p.player || {};
				const fullName = `${playerObj.first_name || ''} ${playerObj.last_name || ''}`.trim() || 'Unknown Player';
				const rawMin = p.minute !== undefined && p.minute !== null ? `${p.minute}:00` : '0:00';

				const fg2m = Number(p.two_point_made ?? 0);
				const fg2a = Number(p.two_point_all ?? 0);
				const fg3m = Number(p.three_point_made ?? 0);
				const fg3a = Number(p.three_point_all ?? 0);
				const ftm = Number(p.free_throw_made ?? 0);
				const fta = Number(p.free_throw_all ?? 0);

				const fgm = fg2m + fg3m;
				const fga = fg2a + fg3a;

				const oreb = Number(p.offensive_rebound ?? 0);
				const dreb = Number(p.defensive_rebound ?? 0);
				const reb = Number(p.total_rebound ?? (oreb + dreb));
				const ast = Number(p.assist ?? 0);
				const stl = Number(p.steal ?? 0);
				const blk = Number(p.block ?? 0);
				const tov = Number(p.turnover ?? 0);
				const pf = Number(p.foul ?? 0);
				const pts = Number(p.points ?? 0);
				const plus_minus = Number(p.plusminus ?? 0);

				return {
					playerId: playerObj.id ? `p-${playerObj.id}` : slugify(fullName),
					playerName: fullName,
					statistics: {
						min: rawMin,
						pts,
						fgm,
						fga,
						fg3m,
						fg3a,
						ftm,
						fta,
						oreb,
						dreb,
						reb,
						ast,
						stl,
						blk,
						tov,
						pf,
						plus_minus
					}
				};
			});
		};

		// Sort teams: home team first, then away
		const homeBlock = teamBlocks.find(t => t.is_home) || teamBlocks[0];
		const awayBlock = teamBlocks.find(t => !t.is_home) || teamBlocks[1];

		const homePlayers = mapPlayers(homeBlock.players);
		const awayPlayers = mapPlayers(awayBlock.players);

		const homeTeamName = cleanTeamName(homeBlock.team?.name || 'Home Team');
		const awayTeamName = cleanTeamName(awayBlock.team?.name || 'Away Team');

		// Resolve score from scheduleItem competitors or player sums
		let homeScore = 0;
		let awayScore = 0;
		if (scheduleItem?.competitors?.length >= 2) {
			for (const c of scheduleItem.competitors) {
				if (c.side === 1) homeScore = Number(c.finalScore ?? 0);
				if (c.side === 2) awayScore = Number(c.finalScore ?? 0);
			}
		}
		if (homeScore === 0) homeScore = homePlayers.reduce((sum, p) => sum + p.statistics.pts, 0);
		if (awayScore === 0) awayScore = awayPlayers.reduce((sum, p) => sum + p.statistics.pts, 0);

		// Resolve game date
		let gameDate = '';
		if (scheduleItem?.game_time) {
			gameDate = scheduleItem.game_time.split(' ')[0] || '';
		}
		if (!gameDate) {
			gameDate = `${yearPrefix}-10-15`;
		}

		const mapTotals = (playersList, score) => {
			let fgm = 0, fga = 0, fg3m = 0, fg3a = 0, ftm = 0, fta = 0;
			let oreb = 0, dreb = 0, reb = 0, ast = 0, stl = 0, blk = 0, tov = 0, pf = 0;
			for (const p of playersList) {
				const s = p.statistics;
				fgm += s.fgm; fga += s.fga; fg3m += s.fg3m; fg3a += s.fg3a;
				ftm += s.ftm; fta += s.fta; oreb += s.oreb; dreb += s.dreb;
				reb += s.reb; ast += s.ast; stl += s.stl; blk += s.blk;
				tov += s.tov; pf += s.pf;
			}
			return {
				pts: score,
				fgm, fga, fg3m, fg3a, ftm, fta,
				oreb, dreb, reb, ast, stl, blk, tov, pf
			};
		};

		const finalBoxscore = {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate,
			homeTeam: {
				teamId: (homeBlock.team?.short_name || homeTeamName.substring(0, 4)).toUpperCase(),
				teamName: homeTeamName,
				score: homeScore,
				statistics: mapTotals(homePlayers, homeScore),
				players: homePlayers
			},
			awayTeam: {
				teamId: (awayBlock.team?.short_name || awayTeamName.substring(0, 4)).toUpperCase(),
				teamName: awayTeamName,
				score: awayScore,
				statistics: mapTotals(awayPlayers, awayScore),
				players: awayPlayers
			}
		};

		if (jsonCachePath) {
			await fs.writeFile(jsonCachePath, JSON.stringify(finalBoxscore, null, 2), 'utf8');
			console.log(`💾 Saved unified BNXT boxscore to side-cache: ${jsonCachePath}`);
		}

		return finalBoxscore;
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
	 * @description Generates mock data for testing/fallback.
	 * @param {string} gameId
	 * @returns {Object}
	 */
	getMockUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix } = this.parseGameId(gameId);
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: `${yearPrefix}-09-14`,
			homeTeam: {
				teamId: "OOS",
				teamName: "Filou Oostende",
				score: 83,
				statistics: {
					fgm: 29, fga: 60, fg3m: 9, fg3a: 24, ftm: 16, fta: 20,
					oreb: 8, dreb: 24, reb: 32, ast: 20, stl: 7, blk: 3, tov: 11, pf: 18
				},
				players: [
					{
						playerId: "p-242",
						playerName: "Joppe Mennes",
						statistics: {
							min: "32:00", pts: 9, fgm: 3, fga: 8, fg3m: 1, fg3a: 4, ftm: 2, fta: 2,
							oreb: 0, dreb: 2, reb: 2, ast: 5, stl: 0, blk: 0, tov: 1, pf: 1, plus_minus: 6
						}
					},
					{
						playerId: "p-243",
						playerName: "Pierre-Antoine Gillet",
						statistics: {
							min: "28:15", pts: 15, fgm: 5, fga: 9, fg3m: 4, fg3a: 7, ftm: 1, fta: 2,
							oreb: 1, dreb: 5, reb: 6, ast: 3, stl: 2, blk: 1, tov: 2, pf: 2, plus_minus: 12
						}
					}
				]
			},
			awayTeam: {
				teamId: "CHA",
				teamName: "Spirou Basket",
				score: 71,
				statistics: {
					fgm: 23, fga: 62, fg3m: 6, fg3a: 30, ftm: 19, fta: 23,
					oreb: 9, dreb: 22, reb: 31, ast: 11, stl: 6, blk: 1, tov: 17, pf: 27
				},
				players: [
					{
						playerId: "p-301",
						playerName: "Milan Samardzic",
						statistics: {
							min: "24:00", pts: 11, fgm: 4, fga: 8, fg3m: 2, fg3a: 5, ftm: 1, fta: 2,
							oreb: 0, dreb: 3, reb: 3, ast: 4, stl: 1, blk: 0, tov: 3, pf: 3, plus_minus: -8
						}
					}
				]
			}
		};
	}
}

export default BnxtScraper;
