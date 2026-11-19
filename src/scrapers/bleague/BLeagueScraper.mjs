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
	 * @description Resolves the raw official payload for a schedule key. Order: raw payload
	 * side-cache -> official S3 JSON -> `game_detail` HTML embed. Both `request()` (box scores)
	 * and `fetchPbp()` (play-by-play) share this path, so a box-score run fully seeds the cache
	 * that a later `--type=pbp` run reuses without touching the network.
	 * @param {string} scheduleKey - Official B.League schedule key
	 * @param {string} yearPrefix - Four digit season start year (locates the side-cache directory)
	 * @returns {Promise<Object|null>} Parsed payload, or null when every transport fails
	 */
	async resolvePayload(scheduleKey, yearPrefix) {
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

		return (payload && typeof payload === 'object') ? payload : null;
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

		const payload = await this.resolvePayload(scheduleKey, yearPrefix);
		if (!payload) {
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
	 * @description Resolves the raw play-by-play payload for a game ID. The official B.League
	 * `v2_genius_contexts` payload carries `PlayByPlays` alongside the box score sections, so
	 * PBP extraction reuses the exact side-cache populated by a box-score run (zero extra
	 * requests when the cache is warm).
	 * @param {string} gameId - Unified game identifier (e.g. `BLEAGUE2026_506379`)
	 * @param {string|number} year - Season start year, used when the game ID carries no season
	 * @returns {Promise<Object>} Payload containing a `PlayByPlays` array (possibly empty)
	 * @throws {Error} When no schedule key can be derived or every payload transport fails
	 */
	async fetchPbp(gameId, year) {
		const { yearPrefix, scheduleKey } = this.parseGameId(gameId);

		// Test mode bypasses the network entirely.
		if (this.bypassNetwork) {
			return this.getMockPbpPayload(gameId);
		}

		if (!scheduleKey) {
			throw new Error(`Unable to derive a B.League schedule key from game ID ${gameId}.`);
		}

		const payload = await this.resolvePayload(scheduleKey, yearPrefix || String(year));
		if (!payload) {
			throw new Error(`No official B.League payload resolved for ${gameId} (S3 and game_detail HTML both failed).`);
		}

		// Fixtures without recorded play-by-play (unplayed, postponed or a stripped feed) expose
		// no `PlayByPlays` key at all. Normalize them to an empty event list so the extract
		// stage logs its "0 PBP actions" skip instead of failing schema validation.
		if (!Array.isArray(payload.PlayByPlays)) {
			console.warn(`⚠️ [BLeagueScraper] Payload for ${gameId} contains no PlayByPlays section (PlayByPlayExistsFlg=false). Returning empty play-by-play.`);
			return payload.Game ? { PlayByPlays: [], Game: payload.Game } : { PlayByPlays: [] };
		}

		return payload;
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

	/**
	 * @description Generates mock play-by-play payloads used by the test suite. The mock mirrors
	 * the official feed's semantics: ragged rows, `Score` omitted on substitution rows, a
	 * starting-lineup substitution run before the period marker, a mid-quarter substitution run,
	 * a period boundary, a `BASKET_COUNT` row that does not move the score, and assist rows that
	 * follow their made field goal. The two mock games reuse the schedule keys of the mock box
	 * scores (`20001`, `20002`) and their `Game` headers agree with those final scores.
	 * @param {string} gameId - Unified game identifier
	 * @returns {Object} Mock payload containing `Game` and `PlayByPlays`
	 */
	getMockPbpPayload(gameId) {
		const { scheduleKey, yearPrefix } = this.parseGameId(gameId);
		const secondGame = scheduleKey === '20002';

		/**
		 * @description Builds one ragged official-style play row with feed defaults applied.
		 * @param {number} No - Official record number
		 * @param {number} ActionCD1 - Event code
		 * @param {number} Period - Period number
		 * @param {string} RestTime - Remaining period clock
		 * @param {string|null} Score - Post-action `home-away` score
		 * @param {Record<string, any>} [extra={}] - Row specific overrides (side, actors, coords)
		 * @returns {Record<string, any>} Raw play row
		 */
		const mkRow = (No, ActionCD1, Period, RestTime, Score, extra = {}) => ({
			Period,
			Code: 100001,
			ScheduleKey: Number(scheduleKey) || 0,
			TeamID: null,
			TeamNameJ: null,
			PlayerID1: null,
			PlayerNo1: '',
			PlayerNameJ1: '',
			No,
			RecordDateTime: `${yearPrefix || '2024'}-12-01 19:00:00`,
			RecordEditDateTime: null,
			RestTime,
			Score,
			PeriodEndRowFlg: false,
			GameEndRowFlg: false,
			ActionCD1,
			ActionCD2: null,
			ActionCD3: null,
			Success: 1,
			Side: 'left',
			PlayText: '',
			...extra
		});

		if (secondGame) {
			return {
				Game: {
					Code: 200002,
					ScheduleKey: Number(scheduleKey) || 0,
					MaxPeriod: 4,
					Year: Number(yearPrefix) || 2024,
					GameEndedFlg: true,
					PlayByPlayExistsFlg: true,
					BoxscoreExistsFlg: true,
					HomeTeamID: '9003',
					HomeTeamNameE: 'SENDAI 89ERS',
					AwayTeamID: '9004',
					AwayTeamNameE: 'YOKOHAMA B-CORSAIRS',
					HomeTeamScore: 78,
					AwayTeamScore: 85
				},
				PlayByPlays: [
					mkRow(1000, 80, 1, '10:00', '0-0', { PlayText: '試合開始 ' }),
					mkRow(2000, 86, 1, '10:00', null, {
						HomeAway: 1, TeamID: '9003', PlayerID1: '9301', PlayerNo1: '1', PlayText: '#1 仙台 プレイヤーイン'
					}),
					mkRow(2000, 86, 1, '10:00', null, {
						HomeAway: 2, TeamID: '9004', PlayerID1: '9401', PlayerNo1: '2', PlayText: '#2 横浜 プレイヤーイン'
					}),
					mkRow(3000, 82, 1, '10:00', '0-0', { PlayText: 'ピリオドスタート' }),
					mkRow(4000, 1, 1, '9:50', '78-85', {
						HomeAway: 1, TeamID: '9003', PlayerID1: '9301', PlayerNo1: '1',
						ActionCD2: 27, X: 74.0, Y: 26.5, Success: 1,
						PlayText: '#1 仙台 3Pシュート○  ジャンプショット '
					}),
					mkRow(5000, 81, 1, '0:00', '78-85', { PlayText: '試合終了 ' })
				]
			};
		}

		/** @type {Array<[string, string, string]>} Home starter [playerId, jersey, name] triples */
		const homeStarters = [
			['9101', '1', '山田'],
			['9102', '4', '佐藤'],
			['9103', '7', '鈴木'],
			['9104', '10', '高橋'],
			['9105', '13', '田中']
		];
		/** @type {Array<[string, string, string]>} Away starter [playerId, jersey, name] triples */
		const awayStarters = [
			['9201', '2', '青山'],
			['9202', '5', '渡辺'],
			['9203', '8', '小林'],
			['9204', '11', '中村'],
			['9205', '14', '松本']
		];

		const starterRows = [
			...homeStarters.map(([playerId, jersey, name]) => mkRow(2000, 86, 1, '10:00', null, {
				HomeAway: 1, TeamID: '9001', PlayerID1: playerId, PlayerNo1: jersey,
				PlayText: `#${jersey} ${name} プレイヤーイン`
			})),
			...awayStarters.map(([playerId, jersey, name]) => mkRow(2000, 86, 1, '10:00', null, {
				HomeAway: 2, TeamID: '9002', PlayerID1: playerId, PlayerNo1: jersey,
				PlayText: `#${jersey} ${name} プレイヤーイン`
			}))
		];

		return {
			Game: {
				Code: 200001,
				ScheduleKey: Number(scheduleKey) || 0,
				MaxPeriod: 4,
				Year: Number(yearPrefix) || 2024,
				GameEndedFlg: true,
				PlayByPlayExistsFlg: true,
				BoxscoreExistsFlg: true,
				HomeTeamID: '9001',
				HomeTeamNameE: 'NAGASAKI VELCA',
				AwayTeamID: '9002',
				AwayTeamNameE: 'SEAHORSES MIKAWA',
				HomeTeamScore: 12,
				AwayTeamScore: 9
			},
			PlayByPlays: [
				mkRow(1000, 80, 1, '10:00', '0-0', { PlayText: '試合開始 ' }),
				...starterRows,
				mkRow(3000, 82, 1, '10:00', '0-0', { PlayText: 'ピリオドスタート' }),
				mkRow(3000, 84, 1, '10:00', '0-0', { PlayText: 'タイムスタート' }),
				// Made three + its assist row (the assist follows the basket it credits).
				mkRow(4000, 1, 1, '9:30', '3-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9101', PlayerNo1: '1',
					ActionCD2: 27, X: 75.5, Y: 25.0, Success: 1,
					PlayText: '#1 山田 3Pシュート○  ジャンプショット '
				}),
				mkRow(5000, 12, 1, '9:28', '3-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9102', PlayerNo1: '4',
					PlayText: '#4 佐藤 アシスト (1本)'
				}),
				// Missed shot, rebound, turnover for the away side.
				mkRow(6000, 5, 1, '9:10', '3-0', {
					HomeAway: 2, TeamID: '9002', PlayerID1: '9201', PlayerNo1: '2',
					ActionCD2: 28, X: 45.0, Y: 55.0, Success: 0,
					PlayText: '#2 青山 2Pシュート アウトサイドペイント×  ジャンプショット'
				}),
				mkRow(7000, 9, 1, '9:08', '3-0', {
					HomeAway: 2, TeamID: '9002', PlayerID1: '9202', PlayerNo1: '5',
					PlayText: '#5 渡辺 ディフェンスリバウンド (0-1-1)'
				}),
				mkRow(8000, 13, 1, '9:00', '3-0', {
					HomeAway: 2, TeamID: '9002', PlayerID1: '9202', PlayerNo1: '5',
					PlayText: '#5 渡辺 ターンオーバー (1本)'
				}),
				// Shooting foul sequence: made two, personal foul, basket count (no score
				// change), then the free throws.
				mkRow(9000, 4, 1, '8:50', '5-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9103', PlayerNo1: '7',
					ActionCD2: 28, X: 10.0, Y: 20.0, Success: 1,
					PlayText: '#7 鈴木 2Pシュートインサイドペイント○  レイアップ'
				}),
				mkRow(10000, 22, 1, '8:50', '5-0', {
					HomeAway: 2, TeamID: '9002', PlayerID1: '9203', PlayerNo1: '8',
					ActionCD2: 30, PlayText: '#8 小林 パーソナルファウル (1-1:1)  フリースローオンファウル1  シュートファウル'
				}),
				mkRow(11000, 16, 1, '8:50', '5-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9103', PlayerNo1: '7',
					PlayText: '#7 鈴木 バスケットカウント'
				}),
				mkRow(12000, 7, 1, '8:50', '6-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9103', PlayerNo1: '7',
					ActionCD2: 35, Success: 1, PlayText: '#7 鈴木 フリースロー○ (6点)'
				}),
				mkRow(13000, 8, 1, '8:50', '6-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9103', PlayerNo1: '7',
					Success: 0, PlayText: '#7 鈴木 フリースロー×'
				}),
				// Mid-quarter substitution run: closes the opening stint before applying.
				mkRow(14000, 87, 1, '8:45', '6-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9105', PlayerNo1: '13',
					PlayText: '#13 田中 プレイヤーアウト'
				}),
				mkRow(14000, 86, 1, '8:45', '6-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9106', PlayerNo1: '16',
					PlayText: '#16 伊藤 プレイヤーイン'
				}),
				mkRow(15000, 85, 1, '8:44', '6-0', { PlayText: 'タイムストップ' }),
				mkRow(16000, 83, 1, '0:00', '6-0', { PlayText: 'ピリオドエンド' }),
				// Period 2 opens with a substitution run recorded before the period marker.
				mkRow(17000, 87, 2, '10:00', '6-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9106', PlayerNo1: '16',
					PlayText: '#16 伊藤 プレイヤーアウト'
				}),
				mkRow(17000, 86, 2, '10:00', '6-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9105', PlayerNo1: '13',
					PlayText: '#13 田中 プレイヤーイン'
				}),
				mkRow(18000, 82, 2, '10:00', '6-0', { PlayText: 'ピリオドスタート' }),
				mkRow(19000, 4, 2, '9:40', '8-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9102', PlayerNo1: '4',
					ActionCD2: 28, X: 12.0, Y: 30.0, Success: 1,
					PlayText: '#4 佐藤 2Pシュートインサイドペイント○  レイアップ'
				}),
				mkRow(20000, 12, 2, '9:38', '8-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9103', PlayerNo1: '7',
					PlayText: '#7 鈴木 アシスト (2本)'
				}),
				mkRow(21000, 22, 2, '9:30', '8-0', {
					HomeAway: 2, TeamID: '9002', PlayerID1: '9204', PlayerNo1: '11',
					ActionCD2: 30, PlayText: '#11 中村 パーソナルファウル (2-1:1)'
				}),
				mkRow(22000, 7, 2, '9:30', '9-0', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9102', PlayerNo1: '4',
					ActionCD2: 35, Success: 1, PlayText: '#4 佐藤 フリースロー○ (9点)'
				}),
				// Away made three: the following HOME assist row must not credit the away shooter.
				mkRow(23000, 1, 2, '9:20', '9-3', {
					HomeAway: 2, TeamID: '9002', PlayerID1: '9204', PlayerNo1: '11',
					ActionCD2: 27, X: 80.0, Y: 25.0, Success: 1,
					PlayText: '#11 中村 3Pシュート○  ジャンプショット'
				}),
				mkRow(24000, 12, 2, '9:18', '9-3', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9104', PlayerNo1: '10',
					PlayText: '#10 高橋 アシスト (1本)'
				}),
				mkRow(25000, 88, 2, '9:00', '9-3', {
					HomeAway: 1, TeamID: '9001', PlayText: 'タイムアウト'
				}),
				mkRow(26000, 1, 2, '0:30', '12-9', {
					HomeAway: 1, TeamID: '9001', PlayerID1: '9105', PlayerNo1: '13',
					ActionCD2: 27, X: 75.0, Y: 25.0, Success: 1,
					PlayText: '#13 田中 3Pシュート○  ジャンプショット  ファストブレイク'
				}),
				mkRow(27000, 81, 2, '0:00', '12-9', { PlayText: '試合終了 ' })
			]
		};
	}
}

export default BLeagueScraper;
