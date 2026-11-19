/**
 * @file CbaParser.mjs
 * @description Parser converting official CBA `data-count` payloads (POST
 * `/api/player-match-datas/data-count`) into the unified box score shape shared by all leagues.
 *
 * Payload shape:
 * - `homeCounts` / `visitingCounts`: per-side row arrays.
 *   - Rows with a `playerId` are real player stat lines (`cnAlias` holds the Chinese player name,
 *     `upTime` holds played seconds).
 *   - The trailing `团队篮板/失误` summary row always carries `playerId: null` and must be filtered;
 *     future/forfeit fixtures contain ONLY that row, so the filtered result is empty and the game
 *     degrades to an unplayed skeleton.
 *
 * Team names, IDs, scores and the calendar date never appear in the payload itself, so the caller
 * supplies them through {@link CbaGameMeta} (harvest-time day feed first, `baseInfo` fallback).
 */

/**
 * @description Official CBA game status codes reported by the day/schedule feeds.
 * @type {{ SCHEDULED: number, LIVE: number, FINAL: number }}
 */
export const CBA_STATUS = Object.freeze({
	SCHEDULED: 1,
	LIVE: 2,
	FINAL: 4
});

/**
 * @description Game metadata used to enrich a `data-count` payload with team identity, official
 * scores and the calendar date (the payload only carries per-player rows).
 * @typedef {Object} CbaGameMeta
 * @property {string} [scheduleId] - Official CBA schedule ID
 * @property {number|null} [status] - Game status (1 scheduled, 2 live, 4 final)
 * @property {string} [homeTeamId] - Official home team ID
 * @property {string} [awayTeamId] - Official visiting team ID
 * @property {string} [homeTeamName] - Chinese home team name
 * @property {string} [awayTeamName] - Chinese visiting team name
 * @property {number|null} [homeScore] - Official home score (null before the game is final)
 * @property {number|null} [awayScore] - Official visiting score (null before the game is final)
 * @property {string} [gameDate] - Scheduled calendar date (`YYYY-MM-DD`)
 */

/**
 * @description Coerces loose payload numeric fields (numbers, numeric strings, blanks) into integers.
 * @param {any} value - Raw value from the payload
 * @returns {number} The coerced integer (0 when not finite)
 */
function toNumber(value) {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : 0;
	}
	const parsed = parseInt(String(value ?? '').trim(), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @description Converts the CBA `upTime` field (played seconds) into the `MM:SS` string expected
 * by the unified box score schema.
 * @param {any} upTime - Played seconds as reported by the official API
 * @returns {string} `MM:SS` clock string (`00:00` for missing/invalid input)
 */
export function formatUpTime(upTime) {
	const seconds = Number(upTime);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return '00:00';
	}
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	const remainder = total % 60;
	return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

/**
 * @description Builds the unplayed/no-boxscore skeleton that downstream stages recognise as
 * "not played yet" via `BaseNormalizer.isGameUnplayed` (empty player rosters). Known team
 * names/scores from `meta` are retained for logging purposes.
 * @param {string} gameId - Unified game identifier (e.g. `CBA2024_100110420`)
 * @param {string} season - Season start year
 * @param {CbaGameMeta|null} [meta] - Optional game metadata used to retain known team names/scores
 * @returns {Object} Unified box score skeleton with empty player arrays
 */
export function createUnplayedSkeleton(gameId, season, meta = null) {
	const known = meta && typeof meta === 'object' ? meta : null;
	return {
		gameId,
		season,
		gameDate: (known && known.gameDate) || '',
		homeTeam: {
			teamId: (known && String(known.homeTeamId ?? '')) || '',
			teamName: (known && known.homeTeamName) || 'Unplayed',
			score: known ? toNumber(known.homeScore) : 0,
			players: []
		},
		awayTeam: {
			teamId: (known && String(known.awayTeamId ?? '')) || '',
			teamName: (known && known.awayTeamName) || 'Unplayed',
			score: known ? toNumber(known.awayScore) : 0,
			players: []
		}
	};
}

/**
 * @description Maps one side's raw `data-count` rows into unified player statistics.
 * The trailing team summary row (`playerId: null`, `cnAlias: '团队篮板/失误'`) is filtered out.
 * @param {any[]} rows - Raw `homeCounts` / `visitingCounts` rows
 * @returns {Object[]} Unified player entries (empty when the side has no player rows)
 */
function parsePlayerRows(rows) {
	if (!Array.isArray(rows) || rows.length === 0) {
		return [];
	}

	return rows
		.filter(row => row && typeof row === 'object' && row.playerId !== null && row.playerId !== undefined && String(row.playerId).trim() !== '')
		.map(row => ({
			playerId: String(row.playerId).trim(),
			playerName: String(row.cnAlias ?? '').trim(),
			statistics: {
				min: formatUpTime(row.upTime),
				pts: toNumber(row.points),
				fgm: toNumber(row.fieldGoals),
				fga: toNumber(row.fieldGoalsAttempted),
				fg3m: toNumber(row.threePointGoals),
				fg3a: toNumber(row.threePointAttempted),
				ftm: toNumber(row.freeThrows),
				fta: toNumber(row.freeThrowsAttempted),
				oreb: toNumber(row.reboundsOffensive),
				dreb: toNumber(row.reboundsDefensive),
				reb: toNumber(row.rebounds),
				ast: toNumber(row.assists),
				stl: toNumber(row.steals),
				blk: toNumber(row.blocked),
				tov: toNumber(row.turnovers),
				pf: toNumber(row.fouls),
				plus_minus: toNumber(row.plusMinus)
			}
		}));
}

/**
 * @description Parses an official CBA `data-count` payload plus its game metadata into the unified
 * box score shape. Returns an unplayed skeleton when the game has not reached a final state or
 * carries no player rows (future fixtures, live games, and forfeits).
 * @param {Object} payload - Raw `data-count` payload (`homeCounts`, `visitingCounts`)
 * @param {string} gameId - Unified game identifier (e.g. `CBA2024_100110420`)
 * @param {string} season - Season start year
 * @param {CbaGameMeta|null} [meta] - Game metadata (team names/IDs/scores/date/status)
 * @returns {Object} Unified box score object
 * @throws {Error} If the payload is not an object
 */
export function parseCbaGame(payload, gameId, season, meta = null) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error(`[CbaParser] Payload for ${gameId} is not an object.`);
	}

	const known = meta && typeof meta === 'object' ? meta : null;

	// Known-but-not-final status: never expose live or scheduled statistics.
	if (known && known.status !== null && known.status !== undefined && Number(known.status) !== CBA_STATUS.FINAL) {
		return createUnplayedSkeleton(gameId, season, known);
	}

	const homePlayers = parsePlayerRows(payload.homeCounts);
	const awayPlayers = parsePlayerRows(payload.visitingCounts);

	// Future/forfeit fixtures only contain the filtered summary row: keep known team
	// identity but expose empty rosters so downstream stages treat it as unplayed.
	if (homePlayers.length === 0 && awayPlayers.length === 0) {
		return createUnplayedSkeleton(gameId, season, known);
	}

	return {
		gameId,
		season,
		gameDate: (known && known.gameDate) || '',
		homeTeam: {
			teamId: (known && String(known.homeTeamId ?? '')) || '',
			teamName: (known && known.homeTeamName) || '',
			score: known ? toNumber(known.homeScore) : 0,
			players: homePlayers
		},
		awayTeam: {
			teamId: (known && String(known.awayTeamId ?? '')) || '',
			teamName: (known && known.awayTeamName) || '',
			score: known ? toNumber(known.awayScore) : 0,
			players: awayPlayers
		}
	};
}
