import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { CbaHarvester } from './harvesters/CbaHarvester.mjs';
import { parseCbaGame, createUnplayedSkeleton } from './parsers/CbaParser.mjs';

/**
 * @description Official CBA data-server API base URL.
 * @type {string}
 */
const CBA_API_BASE = 'https://data-server.cbaleague.com/api';

/**
 * @description Parsed components of a unified CBA game identifier.
 * @typedef {Object} CbaGameIdParts
 * @property {string} competitionId - Always `cba`
 * @property {string} seasonCode - Four digit season start year (e.g. `2024`)
 * @property {string} gameCode - Official schedule ID (e.g. `100110420`)
 * @property {string} yearPrefix - Alias of `seasonCode` used by the extract stage
 * @property {string} scheduleKey - Official schedule ID (alias of `gameCode`)
 */

/**
 * @description Mock player stat line used to build test-mode box scores.
 * @typedef {Object} CbaMockPlayerSpec
 * @property {string} playerId - Mock player ID
 * @property {string} playerName - Mock Chinese player name (mirrors `cnAlias`)
 * @property {string} min - `MM:SS` played clock
 * @property {number} pts - Points
 * @property {number} fgm - Field goals made
 * @property {number} fga - Field goals attempted
 * @property {number} fg3m - Three pointers made
 * @property {number} fg3a - Three pointers attempted
 * @property {number} ftm - Free throws made
 * @property {number} fta - Free throws attempted
 * @property {number} oreb - Offensive rebounds
 * @property {number} dreb - Defensive rebounds
 * @property {number} ast - Assists
 * @property {number} stl - Steals
 * @property {number} blk - Blocks
 * @property {number} tov - Turnovers
 * @property {number} pf - Personal fouls
 * @property {number} plusMinus - Plus/minus
 */

/**
 * @description Builds one mock unified player entry for test mode box scores.
 * @param {CbaMockPlayerSpec} spec - Mock player stat line
 * @returns {Object} Unified player entry
 */
function mockPlayer(spec) {
	return {
		playerId: spec.playerId,
		playerName: spec.playerName,
		statistics: {
			min: spec.min,
			pts: spec.pts,
			fgm: spec.fgm,
			fga: spec.fga,
			fg3m: spec.fg3m,
			fg3a: spec.fg3a,
			ftm: spec.ftm,
			fta: spec.fta,
			oreb: spec.oreb,
			dreb: spec.dreb,
			reb: spec.oreb + spec.dreb,
			ast: spec.ast,
			stl: spec.stl,
			blk: spec.blk,
			tov: spec.tov,
			pf: spec.pf,
			plus_minus: spec.plusMinus
		}
	};
}

/**
 * @class CbaScraper
 * @description Standalone scraper for China's CBA (Chinese Basketball Association).
 *
 * Game data comes from the official CBA infrastructure only:
 * 1. Schedule/meta: `/schedules/month` + `/schedules/day` feeds harvested by `CbaHarvester`
 *    (team names/IDs/scores/status land in `gameIndex`, so box score requests cost zero
 *    extra metadata round-trips; `baseInfo` + day lookup is the standalone fallback).
 * 2. Box scores: POST `/player-match-datas/data-count` with the official schedule ID.
 *
 * English aggregator mirrors (RealGM/Proballers) are intentionally NOT used: they are
 * Cloudflare-gated, carry English team identity, and live in a second identity space.
 *
 * `request()` returns the unified box score shape shared by all leagues, so the raw cache
 * written by the extract stage already holds normalized data.
 */
export class CbaScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper options
	 * @param {string} [options.boxscoreType='traditional'] - Box score metric type
	 */
	constructor(options = {}) {
		super(CBA_API_BASE, { 'isEncrypt': 'no', 'content-type': 'application/json' });
		this.options = options;
		this.harvester = new CbaHarvester(this);
		this.gameSlugs = [];
		/** @type {Set<string>} Schedule IDs of fixtures that have not reached a final state */
		this.unplayedGameIds = new Set();
		/** @type {Map<string, Object>} Schedule ID -> harvest-time game metadata */
		this.gameIndex = new Map();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all CBA game slugs/IDs for a given season.
	 * @param {string|number} year - The season start year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the season code and official schedule ID from a unified game ID.
	 * Game IDs are formatted as `CBA{year}_{scheduleId}` (e.g. `CBA2024_100110420`).
	 * @param {string} gameId - Unified game identifier
	 * @returns {CbaGameIdParts} Parsed game identifier parts
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || '';
		const gameCode = parts[1] || '';

		const segmentMatch = keyPart.match(/CBA(\d{4})/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : String(new Date().getFullYear());

		return {
			competitionId: 'cba',
			seasonCode,
			gameCode,
			yearPrefix: seasonCode,
			scheduleKey: gameCode
		};
	}

	/**
	 * @description Returns the official `gameReport` page URL for a game ID (used for logging
	 * and as the human-readable source link).
	 * @param {string} gameId - Unified game identifier
	 * @returns {string} Absolute game report URL
	 */
	getGameEndpoint(gameId) {
		const { scheduleKey } = this.parseGameId(gameId);
		return `https://www.cbaleague.com/data/#/gameReport?scheduleId=${scheduleKey}`;
	}

	/**
	 * @description Returns the game ID itself, matching the convention used by the other
	 * standalone league scrapers where `request()` is driven directly by the game ID.
	 * @param {string} gameId - Unified game identifier
	 * @returns {string} The game ID
	 */
	getGameUrl(gameId) {
		return gameId;
	}

	/**
	 * @description Fetches the official `data-count` box score payload for a schedule ID.
	 * @param {string|number} scheduleId - Official CBA schedule ID
	 * @returns {Promise<Object|null>} Parsed payload, or null when unavailable/not an object
	 */
	async fetchBoxPayload(scheduleId) {
		try {
			const payload = await super.request('/player-match-datas/data-count', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scheduleId: String(scheduleId) })
			}, 2, 1000);
			return (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : null;
		} catch (error) {
			console.warn(`⚠️ [CbaScraper] data-count fetch failed for ${scheduleId}: ${error.message}`);
			return null;
		}
	}

	/**
	 * @description Resolves game metadata (team names/IDs, official scores, date, status).
	 * Prefers the harvest-time `gameIndex` (zero requests) and falls back to
	 * `baseInfo/{scheduleId}` plus a day-feed status lookup for standalone `request()` runs.
	 * @param {string|number} scheduleId - Official CBA schedule ID
	 * @returns {Promise<Object>} Game metadata (status is null when it could not be resolved)
	 */
	async fetchGameMeta(scheduleId) {
		const key = String(scheduleId);
		const indexed = (this.gameIndex instanceof Map) ? this.gameIndex.get(key) : null;
		if (indexed) {
			return indexed;
		}

		/** @type {import('./parsers/CbaParser.mjs').CbaGameMeta} */
		const meta = {
			scheduleId: key,
			status: null,
			homeTeamId: '',
			awayTeamId: '',
			homeTeamName: '',
			awayTeamName: '',
			homeScore: null,
			awayScore: null,
			gameDate: ''
		};

		try {
			const info = await super.request(`/team-match-datas/getMatchDataReport/baseInfo/${key}`, {}, 1, 500);
			if (info && typeof info === 'object') {
				meta.homeTeamId = String(info.hostTeamId ?? '');
				meta.awayTeamId = String(info.guestTeamId ?? '');
				meta.homeTeamName = String(info.hostTeamName ?? '');
				meta.awayTeamName = String(info.guestTeamName ?? '');
				meta.homeScore = info.hostScore ?? null;
				meta.awayScore = info.guestScore ?? null;
				meta.gameDate = String(info.scheduleTime ?? '').slice(0, 10);
			}
		} catch (error) {
			console.warn(`⚠️ [CbaScraper] baseInfo lookup failed for ${key}: ${error.message}`);
		}

		// Without a harvest-time index the final-state gate comes from the day feed.
		if (meta.gameDate) {
			try {
				const dayGames = await super.request(`/schedules/day?day=${meta.gameDate}&auto=0`, {}, 1, 500);
				const found = Array.isArray(dayGames)
					? dayGames.find(game => game && String(game.scheduleId) === key)
					: null;
				if (found && found.status !== null && found.status !== undefined) {
					meta.status = Number(found.status);
				}
			} catch (error) {
				console.warn(`⚠️ [CbaScraper] Day status lookup failed for ${key}: ${error.message}`);
			}
		}

		return meta;
	}

	/**
	 * @description Resolves the unified box score for a game ID.
	 * Order: mock (test mode) -> metadata gate -> raw payload side-cache -> official
	 * `data-count` POST -> unplayed skeleton.
	 * @param {string} url - Unified game ID (the extract stage passes `getGameUrl()` output)
	 * @param {Object} [options] - Unused request options, kept for API parity
	 * @param {number} [retries] - Unused retry hint, kept for API parity
	 * @param {number} [delay] - Unused delay hint, kept for API parity
	 * @returns {Promise<Object>} Unified box score object
	 */
	async request(url, options = {}, retries = 3, delay = 1000) {
		const gameId = url;
		const { yearPrefix, scheduleKey } = this.parseGameId(gameId);

		// Test mode bypasses the network entirely.
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		if (!scheduleKey) {
			console.warn(`⚠️ [CbaScraper] Unable to derive a schedule ID from game ID ${gameId}. Returning unplayed skeleton.`);
			return createUnplayedSkeleton(gameId, yearPrefix);
		}

		// 1. Game metadata: harvest-time day feed first (zero requests), baseInfo fallback.
		let meta = null;
		try {
			meta = await this.fetchGameMeta(scheduleKey);
		} catch (error) {
			console.warn(`⚠️ [CbaScraper] Metadata lookup failed for ${scheduleKey}: ${error.message}`);
		}

		if (meta && meta.status !== null && meta.status !== undefined && Number(meta.status) !== 4) {
			console.log(`⏭️ [CbaScraper] Game ${scheduleKey} has not finished (status ${meta.status}). Returning unplayed skeleton.`);
			return createUnplayedSkeleton(gameId, yearPrefix, meta);
		}

		// 2. Side-cache lives in a subdirectory so the flat `data/raw/<league>/<year>` scan
		// performed by the transform stage never picks these files up as games.
		const cacheDir = path.resolve('data/raw/cba', String(yearPrefix), 'payloads');
		await fs.mkdir(cacheDir, { recursive: true });
		const payloadCachePath = path.join(cacheDir, `${scheduleKey}.json`);

		let payload = null;
		let fromCache = false;
		try {
			const stats = await fs.stat(payloadCachePath);
			if (stats.size > 0) {
				payload = JSON.parse(await fs.readFile(payloadCachePath, 'utf8'));
				fromCache = true;
				console.log(`⏭️ [CbaScraper] Payload cache found for game ${scheduleKey}. Reading from disk...`);
			}
		} catch (error) {
			payload = null;
		}

		if (!payload || typeof payload !== 'object') {
			payload = await this.fetchBoxPayload(scheduleKey);
		}

		if (!payload || typeof payload !== 'object') {
			console.warn(`⚠️ [CbaScraper] No payload available for ${scheduleKey}. Returning unplayed skeleton.`);
			return createUnplayedSkeleton(gameId, yearPrefix, meta);
		}

		let boxscore;
		try {
			boxscore = parseCbaGame(payload, gameId, yearPrefix, meta);
		} catch (error) {
			console.error(`❌ [CbaScraper] Failed to parse payload for ${gameId}: ${error.message}`);
			return createUnplayedSkeleton(gameId, yearPrefix, meta);
		}

		// Cache only finished games with real player rows so live/partial payloads
		// (and forfeits that only carry the team summary row) are never persisted.
		if (!fromCache && meta && meta.status !== null && Number(meta.status) === 4 &&
			boxscore.homeTeam.players.length > 0 && boxscore.awayTeam.players.length > 0) {
			await fs.writeFile(payloadCachePath, JSON.stringify(payload), 'utf8');
			console.log(`💾 [CbaScraper] Saved raw data-count payload to ${payloadCachePath}`);
		}

		return boxscore;
	}

	/**
	 * @description Returns a schema-compliant unplayed skeleton box score.
	 * @param {string} gameId - Unified game identifier
	 * @param {string} yearPrefix - Season start year
	 * @param {Object|null} [meta] - Optional game metadata to retain team names/scores
	 * @returns {Object} Unified box score skeleton with empty player arrays
	 */
	getUnplayedSkeleton(gameId, yearPrefix, meta = null) {
		return createUnplayedSkeleton(gameId, yearPrefix, meta);
	}

	/**
	 * @description Generates mock unified box scores used by the test suite.
	 * Player points sum exactly to the official team scores (no points variance).
	 * @param {string} gameId - Unified game identifier
	 * @returns {Object} Mock unified box score
	 */
	getMockUnifiedBoxScore(gameId) {
		const { yearPrefix, scheduleKey } = this.parseGameId(gameId);
		const secondGame = scheduleKey === '20002';

		return {
			gameId,
			season: yearPrefix,
			gameDate: `${yearPrefix}-12-01`,
			homeTeam: secondGame
				? {
					teamId: '29140',
					teamName: '浙江稠州金租',
					score: 78,
					players: [
						mockPlayer({ playerId: '90006', playerName: '吴前', min: '36:15', pts: 44, fgm: 14, fga: 25, fg3m: 7, fg3a: 15, ftm: 9, fta: 10, oreb: 1, dreb: 5, ast: 7, stl: 2, blk: 0, tov: 4, pf: 3, plusMinus: 6 }),
						mockPlayer({ playerId: '90007', playerName: '程帅澎', min: '30:05', pts: 34, fgm: 11, fga: 18, fg3m: 4, fg3a: 9, ftm: 8, fta: 9, oreb: 0, dreb: 4, ast: 5, stl: 2, blk: 0, tov: 2, pf: 4, plusMinus: 4 })
					]
				}
				: {
					teamId: '29124',
					teamName: '广东东阳光',
					score: 86,
					players: [
						mockPlayer({ playerId: '90001', playerName: '胡明轩', min: '31:05', pts: 30, fgm: 11, fga: 19, fg3m: 4, fg3a: 9, ftm: 4, fta: 5, oreb: 1, dreb: 4, ast: 6, stl: 2, blk: 0, tov: 3, pf: 2, plusMinus: 12 }),
						mockPlayer({ playerId: '90002', playerName: '马尚·布鲁克斯', min: '28:40', pts: 28, fgm: 10, fga: 17, fg3m: 3, fg3a: 7, ftm: 5, fta: 6, oreb: 0, dreb: 5, ast: 4, stl: 1, blk: 0, tov: 2, pf: 3, plusMinus: 9 }),
						mockPlayer({ playerId: '90003', playerName: '徐杰', min: '33:10', pts: 28, fgm: 9, fga: 15, fg3m: 4, fg3a: 8, ftm: 6, fta: 6, oreb: 0, dreb: 2, ast: 8, stl: 2, blk: 0, tov: 1, pf: 1, plusMinus: 11 })
					]
				},
			awayTeam: secondGame
				? {
					teamId: '29117',
					teamName: '新疆伊力特',
					score: 85,
					players: [
						mockPlayer({ playerId: '90008', playerName: '阿不都沙拉木', min: '34:50', pts: 45, fgm: 15, fga: 24, fg3m: 3, fg3a: 7, ftm: 12, fta: 13, oreb: 3, dreb: 7, ast: 4, stl: 2, blk: 1, tov: 3, pf: 3, plusMinus: 5 }),
						mockPlayer({ playerId: '90009', playerName: '齐麟', min: '31:30', pts: 40, fgm: 13, fga: 21, fg3m: 6, fg3a: 12, ftm: 8, fta: 9, oreb: 1, dreb: 4, ast: 3, stl: 1, blk: 0, tov: 2, pf: 2, plusMinus: 3 })
					]
				}
				: {
					teamId: '29129',
					teamName: '辽宁本钢',
					score: 69,
					players: [
						mockPlayer({ playerId: '90004', playerName: '赵继伟', min: '35:20', pts: 36, fgm: 12, fga: 21, fg3m: 6, fg3a: 12, ftm: 6, fta: 6, oreb: 1, dreb: 3, ast: 9, stl: 3, blk: 0, tov: 2, pf: 3, plusMinus: -8 }),
						mockPlayer({ playerId: '90005', playerName: '张镇麟', min: '32:45', pts: 33, fgm: 12, fga: 20, fg3m: 5, fg3a: 10, ftm: 4, fta: 5, oreb: 2, dreb: 6, ast: 3, stl: 1, blk: 2, tov: 3, pf: 4, plusMinus: -9 })
					]
				}
		};
	}
}

export default CbaScraper;
