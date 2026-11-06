import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { KorisliigaHarvester } from './harvesters/KorisliigaHarvester.mjs';

/**
 * @description Scraper for Finnish Korisliiga domestic basketball competition.
 * Fetches, caches, parses, and normalizes Korisliiga game box score statistics from basket.fi.
 */
export class KorisliigaScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://basket.fi');
		this.harvester = new KorisliigaHarvester(this);
		this.gameSlugs = [];
		this.gameMetadataMap = new Map();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
		this.baseUrl = 'https://basket.fi/wp-json/basket/v1/pena-api/api/v1';
		this.korisliigaCompId = 'f874dc00-e92f-5090-beb3-e47826cda185';
	}

	/**
	 * @description Associates metadata with a game ID.
	 * @param {string} gameId
	 * @param {Object} metadata
	 */
	setGameMetadata(gameId, metadata) {
		this.gameMetadataMap.set(String(gameId), metadata);
	}

	/**
	 * @description Fetches all game slugs/IDs for Korisliiga for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a Korisliiga gameId.
	 * Korisliiga game ID is formatted as matchup-F{season}_{gameCode}, e.g. tampereen-pyrinto-vs-kataja-basket-F2024_431de40c-bebb-5f53-813d-66c80842ff20.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'F2024';

		// Extract season code segment from keyPart, e.g. "F2024" -> "2024" or "matchup-F2024" -> "2024"
		const segmentMatch = keyPart.match(/(?:-)?F(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2024';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'korisliiga',
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
		const { gameCode } = this.parseGameId(gameId);
		return `https://basket.fi/sarjat/sarjat/korisliiga/tilastot/?gs_tab=results&game_id=${gameCode}`;
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
	 * @description Resolves the season_public_id from season year.
	 * @param {string|number} year
	 * @returns {Promise<string>}
	 */
	async resolveSeasonPublicId(year) {
		const targetYear = String(year);
		try {
			const seasonsRes = await fetch(`${this.baseUrl}/competitions/${this.korisliigaCompId}/seasons`);
			if (seasonsRes.ok) {
				const json = await seasonsRes.json();
				const matched = (json.seasons || []).find(s =>
					s.season_start_year === targetYear ||
					s.season_year === targetYear ||
					(s.season_name && s.season_name.startsWith(targetYear))
				);
				if (matched?.season_public_id) {
					return matched.season_public_id;
				}
			}
		} catch (e) {
			// fallback
		}
		return '789eea74-4775-5aa8-a190-d49ced3c31c4';
	}

	/**
	 * @description Formats unified box score by loading Korisliiga match data from API or side-cache.
	 * @param {string} gameId - Combined game identifier, e.g. 'matchup-F2024_431de40c-bebb-5f53-813d-66c80842ff20'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Set up directories for side-cache JSON saving
		const jsonCacheDir = path.resolve('data/raw/europe/korisliiga', String(yearPrefix));
		await fs.mkdir(jsonCacheDir, { recursive: true });
		const jsonCachePath = path.join(jsonCacheDir, `${gameCode}.json`);

		let cachedContent = '';
		try {
			const stats = await fs.stat(jsonCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [KorisliigaScraper] JSON cache found for game ${gameCode}. Reading from disk...`);
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
			let meta = this.gameMetadataMap.get(String(gameCode));
			const seasonPublicId = meta?.seasonPublicId || await this.resolveSeasonPublicId(yearPrefix);
			const compPublicId = meta?.competitionPublicId || this.korisliigaCompId;

			// 1. Fetch player box score
			const boxUrl = `${this.baseUrl}/competitions/${compPublicId}/seasons/${seasonPublicId}/games/${gameCode}/boxscore`;
			console.log(`📡 [KorisliigaScraper] Loading Korisliiga Boxscore from ${boxUrl}...`);

			const boxRes = await fetch(boxUrl);
			if (!boxRes.ok) {
				throw new Error(`HTTP Error fetching boxscore API: ${boxRes.status} ${boxRes.statusText}`);
			}
			const boxJson = await boxRes.json();
			const teamsList = boxJson.teams || [];

			if (teamsList.length < 2) {
				throw new Error(`Invalid Korisliiga boxscore: received fewer than 2 teams for game ${gameCode}`);
			}

			// 2. Fetch team totals
			let teamTotals = [];
			try {
				const teamStatsUrl = `${this.baseUrl}/competitions/${compPublicId}/seasons/${seasonPublicId}/games/${gameCode}/boxscore/teams`;
				const teamStatsRes = await fetch(teamStatsUrl);
				if (teamStatsRes.ok) {
					const tJson = await teamStatsRes.json();
					teamTotals = tJson.teams || [];
				}
			} catch (e) {
				// non-fatal, fallback to sum
			}

			return this.parseKorisliigaPayload(boxJson, teamTotals, meta?.gameData, gameId, competitionId, yearPrefix, jsonCachePath);
		} catch (error) {
			console.error(`❌ [KorisliigaScraper] Error parsing game ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Parses Korisliiga boxscore JSON and team totals into unified schema.
	 * @param {Object} boxJson
	 * @param {Object[]} teamTotals
	 * @param {Object} [gameData]
	 * @param {string} gameId
	 * @param {string} competitionId
	 * @param {string} yearPrefix
	 * @param {string} jsonCachePath
	 * @returns {Promise<Object>}
	 */
	async parseKorisliigaPayload(boxJson, teamTotals, gameData, gameId, competitionId, yearPrefix, jsonCachePath) {
		const teamsList = boxJson.teams || [];

		const slugify = (text) => {
			return String(text || '')
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, '')
				.trim()
				.replace(/[\s-]+/g, '-');
		};

		const mapPlayers = (rawPlayers) => {
			return (rawPlayers || []).map(p => {
				const fullName = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player';
				const mins = p.minutes !== undefined && p.minutes !== null ? p.minutes : 0;
				const secs = p.seconds !== undefined && p.seconds !== null ? p.seconds : 0;
				const rawMin = `${mins}:${String(secs).padStart(2, '0')}`;

				const fgm = Number(p.fgm ?? ((p.s_2m || 0) + (p.s_3m || 0)));
				const fga = Number(p.fga ?? ((p.s_2a || 0) + (p.s_3a || 0)));
				const fg3m = Number(p.s_3m ?? 0);
				const fg3a = Number(p.s_3a ?? 0);
				const ftm = Number(p.ftm ?? 0);
				const fta = Number(p.fta ?? 0);

				const oreb = Number(p.ro ?? 0);
				const dreb = Number(p.rd ?? 0);
				const reb = Number(p.rt ?? (oreb + dreb));
				const ast = Number(p.ass ?? 0);
				const stl = Number(p.st ?? 0);
				const blk = Number(p.bl_fv ?? 0);
				const tov = Number(p.turnovers ?? 0);
				const pf = Number(p.pf_cm ?? 0);
				const pts = Number(p.points ?? 0);
				const plus_minus = Number(p.plus_minus ?? 0);

				const playerId = p.pena_id ? String(p.pena_id).replace(/^p:person:/, '') : slugify(fullName);

				return {
					playerId,
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

		// In Pena API, teamsList[0] is typically home team (team_a) and [1] away (team_b)
		const homeRawTeam = teamsList[0];
		const awayRawTeam = teamsList[1];

		const homePlayers = mapPlayers(homeRawTeam.players);
		const awayPlayers = mapPlayers(awayRawTeam.players);

		const homeTeamName = homeRawTeam.team_name_fi || homeRawTeam.team_name_en || 'Home Team';
		const awayTeamName = awayRawTeam.team_name_fi || awayRawTeam.team_name_en || 'Away Team';

		// Resolve score from teamTotals or gameData or player sums
		let homeScore = 0;
		let awayScore = 0;

		const homeTotal = teamTotals.find(t => t.team_public_id === homeRawTeam.team_public_id);
		const awayTotal = teamTotals.find(t => t.team_public_id === awayRawTeam.team_public_id);

		if (homeTotal?.points_for !== undefined) homeScore = Number(homeTotal.points_for);
		if (awayTotal?.points_for !== undefined) awayScore = Number(awayTotal.points_for);

		if (homeScore === 0 && gameData?.score_a !== undefined) homeScore = Number(gameData.score_a);
		if (awayScore === 0 && gameData?.score_b !== undefined) awayScore = Number(gameData.score_b);

		if (homeScore === 0) homeScore = homePlayers.reduce((sum, p) => sum + p.statistics.pts, 0);
		if (awayScore === 0) awayScore = awayPlayers.reduce((sum, p) => sum + p.statistics.pts, 0);

		// Resolve date
		let gameDate = '';
		if (gameData?.time) {
			gameDate = gameData.time.split('T')[0] || '';
		}
		if (!gameDate) {
			gameDate = `${yearPrefix}-10-04`;
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
				teamId: homeTeamName.substring(0, 4).toUpperCase(),
				teamName: homeTeamName,
				score: homeScore,
				statistics: mapTotals(homePlayers, homeScore),
				players: homePlayers
			},
			awayTeam: {
				teamId: awayTeamName.substring(0, 4).toUpperCase(),
				teamName: awayTeamName,
				score: awayScore,
				statistics: mapTotals(awayPlayers, awayScore),
				players: awayPlayers
			}
		};

		if (jsonCachePath) {
			await fs.writeFile(jsonCachePath, JSON.stringify(finalBoxscore, null, 2), 'utf8');
			console.log(`💾 Saved unified Korisliiga boxscore to side-cache: ${jsonCachePath}`);
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
			gameDate: `${yearPrefix}-10-04`,
			homeTeam: {
				teamId: "PYR",
				teamName: "Tampereen Pyrintö",
				score: 66,
				statistics: {
					fgm: 23, fga: 65, fg3m: 7, fg3a: 24, ftm: 13, fta: 18,
					oreb: 6, dreb: 22, reb: 28, ast: 14, stl: 5, blk: 4, tov: 15, pf: 19
				},
				players: [
					{
						playerId: "topias-palmi",
						playerName: "Topias Palmi",
						statistics: {
							min: "29:09", pts: 22, fgm: 6, fga: 15, fg3m: 5, fg3a: 8, ftm: 5, fta: 6,
							oreb: 0, dreb: 8, reb: 8, ast: 2, stl: 0, blk: 3, tov: 3, pf: 1, plus_minus: -12
						}
					},
					{
						playerId: "antero-lehto",
						playerName: "Antero Lehto",
						statistics: {
							min: "22:15", pts: 8, fgm: 3, fga: 7, fg3m: 1, fg3a: 3, ftm: 1, fta: 2,
							oreb: 1, dreb: 2, reb: 3, ast: 4, stl: 1, blk: 0, tov: 2, pf: 3, plus_minus: -10
						}
					}
				]
			},
			awayTeam: {
				teamId: "KAT",
				teamName: "Kataja Basket",
				score: 100,
				statistics: {
					fgm: 38, fga: 72, fg3m: 12, fg3a: 28, ftm: 12, fta: 15,
					oreb: 11, dreb: 34, reb: 45, ast: 26, stl: 9, blk: 2, tov: 9, pf: 18
				},
				players: [
					{
						playerId: "tuomas-hirvonen",
						playerName: "Tuomas Hirvonen",
						statistics: {
							min: "25:40", pts: 18, fgm: 6, fga: 10, fg3m: 4, fg3a: 6, ftm: 2, fta: 2,
							oreb: 1, dreb: 4, reb: 5, ast: 8, stl: 2, blk: 0, tov: 1, pf: 2, plus_minus: 20
						}
					}
				]
			}
		};
	}
}

export default KorisliigaScraper;
