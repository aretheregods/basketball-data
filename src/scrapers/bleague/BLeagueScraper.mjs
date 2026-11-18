import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { BLeagueHarvester } from './harvesters/BLeagueHarvester.mjs';
import { parseBLeaguePayload, extractEmbeddedPayload, createUnplayedSkeleton } from './parsers/BLeagueParser.mjs';

/**
 * @description Parsed components of a unified B.League game identifier.
 * @typedef {Object} BLeagueGameIdParts
 * @property {string} competitionId - Always `bleague`
 * @property {string} seasonCode - Four digit season start year (e.g. `2024`)
 * @property {string} gameCode - Official schedule key (e.g. `502710`)
 * @property {string} yearPrefix - Alias of `seasonCode` used by the extract stage
 * @property {string} scheduleKey - Official schedule key (alias of `gameCode`)
 */

/**
 * @class BLeagueScraper
 * @description Standalone scraper for Japan's B.League B1 (B.LEAGUE PREMIER).
 *
 * Game payloads come from the official B.League infrastructure only:
 * 1. Primary: the S3 `v2_genius_contexts` JSON resolved through `.../{ScheduleKey}/latestid`.
 * 2. Fallback: the byte-identical JSON embedded in the official `game_detail` HTML page.
 *
 * `request()` returns the unified box score shape shared by every league, so the raw cache
 * written by the extract stage already holds normalized data.
 */
export class BLeagueScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper options
	 * @param {string} [options.boxscoreType='traditional'] - Box score metric type
	 */
	constructor(options = {}) {
		super('https://www.bleague.jp');
		this.options = options;
		this.harvester = new BLeagueHarvester(this);
		this.gameSlugs = [];
		/** @type {Set<string>} Schedule keys of fixtures that have not reached a final state */
		this.unplayedGameIds = new Set();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all B1 game slugs/IDs for a given season.
	 * @param {string|number} year - The season start year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the season code and official schedule key from a unified game ID.
	 * Game IDs are formatted as `BLEAGUE{year}_{scheduleKey}` (e.g. `BLEAGUE2024_502710`).
	 * @param {string} gameId - Unified game identifier
	 * @returns {BLeagueGameIdParts} Parsed game identifier parts
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || '';
		const gameCode = parts[1] || '';

		const segmentMatch = keyPart.match(/BLEAGUE(\d{4})/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : String(new Date().getFullYear());

		return {
			competitionId: 'bleague',
			seasonCode,
			gameCode,
			yearPrefix: seasonCode,
			scheduleKey: gameCode
		};
	}

	/**
	 * @description Returns the official `game_detail` page URL for a game ID (used for logging
	 * and as the HTML-embed fallback source).
	 * @param {string} gameId - Unified game identifier
	 * @returns {string} Absolute game detail URL
	 */
	getGameEndpoint(gameId) {
		const { scheduleKey } = this.parseGameId(gameId);
		return `https://www.bleague.jp/game_detail/?ScheduleKey=${scheduleKey}&tab=1`;
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
	 * @description Fetches the official S3 `v2_genius_contexts` payload for a schedule key.
	 * Retries are deliberately disabled: S3 answers unplayed and exhibition fixtures with a
	 * permanent `403 AccessDenied`, so retrying only burns time before the HTML fallback runs.
	 * @param {string} scheduleKey - Official B.League schedule key
	 * @returns {Promise<Object|null>} Parsed game payload, or null when S3 has no data
	 */
	async fetchS3Payload(scheduleKey) {
		const baseUrl = 'https://b-league.s3.amazonaws.com/web_json/v2_genius_contexts';
		try {
			const idResponse = await super.request(`${baseUrl}/${scheduleKey}/latestid`, {}, 0, 0);
			const idText = (typeof idResponse === 'number' || typeof idResponse === 'string') ? String(idResponse) : '';
			const s3Id = parseInt(idText.replace(/[^0-9]/g, ''), 10);
			if (!Number.isFinite(s3Id) || s3Id <= 0) {
				return null;
			}

			const payload = await super.request(`${baseUrl}/${scheduleKey}/${s3Id}.json`, {}, 0, 0);
			return (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : null;
		} catch (error) {
			console.warn(`⚠️ [BLeagueScraper] S3 lookup failed for ${scheduleKey}: ${error.message}`);
			return null;
		}
	}

	/**
	 * @description Fetches the official `game_detail` HTML page used as the same-source
	 * fallback transport when the S3 bucket denies access.
	 * @param {string} scheduleKey - Official B.League schedule key
	 * @returns {Promise<string|null>} Raw HTML, or null when the page cannot be retrieved
	 */
	async fetchGameDetailHtml(scheduleKey) {
		const url = `https://www.bleague.jp/game_detail/?ScheduleKey=${scheduleKey}&tab=1`;
		try {
			const response = await fetch(url, {
				headers: {
					'user-agent': this.defaultHeaders['user-agent'],
					'accept': 'text/html,application/xhtml+xml'
				},
				signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
					? AbortSignal.timeout(15000)
					: undefined
			});
			if (!response.ok) {
				console.warn(`⚠️ [BLeagueScraper] game_detail responded HTTP ${response.status} for ${scheduleKey}.`);
				return null;
			}
			return await response.text();
		} catch (error) {
			console.warn(`⚠️ [BLeagueScraper] game_detail fetch failed for ${scheduleKey}: ${error.message}`);
			return null;
		}
	}

	/**
	 * @description Resolves the unified box score for a game ID.
	 * Order: raw payload side-cache -> official S3 JSON -> `game_detail` HTML embed -> skeleton.
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
			console.warn(`⚠️ [BLeagueScraper] Unable to derive a schedule key from game ID ${gameId}. Returning unplayed skeleton.`);
			return createUnplayedSkeleton(gameId, yearPrefix);
		}

		// Side-cache lives in a subdirectory so the flat `data/raw/<league>/<year>` scan
		// performed by the transform stage never picks these files up as games.
		const cacheDir = path.resolve('data/raw/bleague', String(yearPrefix), 'payloads');
		await fs.mkdir(cacheDir, { recursive: true });
		const payloadCachePath = path.join(cacheDir, `${scheduleKey}.json`);
		const htmlCachePath = path.join(cacheDir, `${scheduleKey}.html`);

		// 1. Reuse the raw payload side-cache when present.
		let payload = null;
		try {
			const stats = await fs.stat(payloadCachePath);
			if (stats.size > 0) {
				payload = JSON.parse(await fs.readFile(payloadCachePath, 'utf8'));
				console.log(`⏭️ [BLeagueScraper] Payload cache found for game ${scheduleKey}. Reading from disk...`);
			}
		} catch (error) {
			payload = null;
		}

		// 2. Primary transport: official S3 v2 genius context payload.
		if (!payload || typeof payload !== 'object') {
			payload = await this.fetchS3Payload(scheduleKey);
			if (payload) {
				await fs.writeFile(payloadCachePath, JSON.stringify(payload), 'utf8');
				console.log(`💾 [BLeagueScraper] Saved raw S3 payload to ${payloadCachePath}`);
			}
		}

		// 3. Same-source fallback: JSON embedded in the `game_detail` HTML page.
		if (!payload || typeof payload !== 'object') {
			console.log(`🔄 [BLeagueScraper] S3 payload unavailable for ${scheduleKey}. Falling back to game_detail HTML embed...`);
			let html = null;
			try {
				const stats = await fs.stat(htmlCachePath);
				if (stats.size > 0) {
					html = await fs.readFile(htmlCachePath, 'utf8');
				}
			} catch (error) {
				html = null;
			}

			if (!html) {
				html = await this.fetchGameDetailHtml(scheduleKey);
				if (html) {
					await fs.writeFile(htmlCachePath, html, 'utf8');
					console.log(`💾 [BLeagueScraper] Saved raw game_detail HTML to ${htmlCachePath}`);
				}
			}

			if (html) {
				payload = extractEmbeddedPayload(html);
			}
		}

		if (!payload || typeof payload !== 'object') {
			console.warn(`⚠️ [BLeagueScraper] No payload available for ${scheduleKey}. Returning unplayed skeleton.`);
			return createUnplayedSkeleton(gameId, yearPrefix);
		}

		try {
			return parseBLeaguePayload(payload, gameId, yearPrefix);
		} catch (error) {
			console.error(`❌ [BLeagueScraper] Failed to parse payload for ${gameId}: ${error.message}`);
			return createUnplayedSkeleton(gameId, yearPrefix);
		}
	}

	/**
	 * @description Returns a schema-compliant unplayed skeleton box score.
	 * @param {string} gameId - Unified game identifier
	 * @param {string} yearPrefix - Season start year
	 * @returns {Object} Unified box score skeleton with empty player arrays
	 */
	getUnplayedSkeleton(gameId, yearPrefix) {
		return createUnplayedSkeleton(gameId, yearPrefix);
	}

	/**
	 * @description Generates mock unified box scores used by the test suite.
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
					teamId: 'SEND',
					teamName: 'SENDAI 89ERS',
					score: 78,
					players: [
						{
							playerId: '50003',
							playerName: 'Kaito Ishida',
							statistics: {
								min: '29:40', pts: 17, fgm: 6, fga: 13, fg3m: 2, fg3a: 5, ftm: 3, fta: 4,
								oreb: 0, dreb: 3, reb: 3, ast: 4, stl: 1, blk: 0, tov: 2, pf: 3, plus_minus: -7
							}
						}
					]
				}
				: {
					teamId: 'NAGA',
					teamName: 'NAGASAKI VELCA',
					score: 86,
					players: [
						{
							playerId: '50001',
							playerName: 'Sota Okada',
							statistics: {
								min: '31:05', pts: 24, fgm: 9, fga: 16, fg3m: 3, fg3a: 7, ftm: 3, fta: 4,
								oreb: 1, dreb: 4, reb: 5, ast: 7, stl: 2, blk: 0, tov: 3, pf: 2, plus_minus: 14
							}
						},
						{
							playerId: '50002',
							playerName: 'Leonard Jackson',
							statistics: {
								min: '24:10', pts: 15, fgm: 6, fga: 11, fg3m: 1, fg3a: 3, ftm: 2, fta: 2,
								oreb: 2, dreb: 6, reb: 8, ast: 1, stl: 1, blk: 1, tov: 1, pf: 3, plus_minus: 9
							}
						}
					]
				},
			awayTeam: secondGame
				? {
					teamId: 'YOKO',
					teamName: 'YOKOHAMA B-CORSAIRS',
					score: 85,
					players: [
						{
							playerId: '50004',
							playerName: 'Andre Murray',
							statistics: {
								min: '33:20', pts: 26, fgm: 9, fga: 18, fg3m: 4, fg3a: 9, ftm: 4, fta: 5,
								oreb: 1, dreb: 5, reb: 6, ast: 5, stl: 2, blk: 1, tov: 4, pf: 2, plus_minus: 7
							}
						}
					]
				}
				: {
					teamId: 'MIKA',
					teamName: 'SEAHORSES MIKAWA',
					score: 69,
					players: [
						{
							playerId: '50005',
							playerName: 'Hayato Kumagai',
							statistics: {
								min: '30:50', pts: 19, fgm: 7, fga: 14, fg3m: 2, fg3a: 6, ftm: 3, fta: 4,
								oreb: 3, dreb: 5, reb: 8, ast: 2, stl: 1, blk: 0, tov: 2, pf: 4, plus_minus: -14
							}
						}
					]
				}
		};
	}
}

export default BLeagueScraper;
