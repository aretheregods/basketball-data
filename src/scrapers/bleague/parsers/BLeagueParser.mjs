/**
 * @file BLeagueParser.mjs
 * @description Parser converting official B.League game payloads (S3 `v2_genius_contexts` JSON or the
 * identical JSON embedded in `game_detail` HTML) into the unified box score shape shared by all leagues.
 *
 * Payload shape (both transports):
 * - `Game`: game header (`GameDateTime`, `GameEndedFlg`, team names/IDs/scores, quarterly scores).
 * - `HomeBoxscores` / `AwayBoxscores`: dense row matrix across `Category` x `PeriodCategory` views.
 *   - `Category=1` -> player rows, `Category=2` -> blank filler rows, `Category=3` -> team totals.
 *   - `PeriodCategory` 1-4 -> quarters, 15 -> first half, 16 -> second half, 18 -> full game.
 * - `Summaries`: per-period official team totals.
 */

/**
 * @description Anchor that introduces the embedded payload inside `game_detail` HTML.
 * @type {string}
 */
const EMBED_ANCHOR = /_contexts_s3id\.data\s*=\s*/g;

/**
 * @description Full-game period category used by B.League box score row matrices.
 * @type {number}
 */
const FULL_GAME_PERIOD = 18;

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
 * @description Converts a `/Date(<epochMs><±HHMM>)/` string into a `YYYY-MM-DD` date in the
 * embedded league timezone (JST for B.League).
 * @param {any} gameDateTime - Raw `Game.GameDateTime` value
 * @returns {string} ISO date string, or an empty string when unparseable/missing
 */
export function parseGameDateTime(gameDateTime) {
	if (typeof gameDateTime !== 'string' || gameDateTime === '') {
		return '';
	}
	const match = gameDateTime.match(/\/Date\((\d+)([+-])(\d{2})(\d{2})\)\//);
	if (!match) {
		return '';
	}
	const epochMs = Number(match[1]);
	if (!Number.isFinite(epochMs)) {
		return '';
	}
	const sign = match[2] === '-' ? -1 : 1;
	const offsetMinutes = (Number(match[3]) * 60) + Number(match[4]);
	const localMs = epochMs + (sign * offsetMinutes * 60 * 1000);
	const date = new Date(localMs);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toISOString().slice(0, 10);
}

/**
 * @description Builds the unplayed/no-boxscore skeleton that downstream stages recognise as
 * "not played yet" via `BaseNormalizer.isGameUnplayed` (empty player rosters).
 * @param {string} gameId - Unified game identifier (e.g. `BLEAGUE2024_502710`)
 * @param {string} season - Season start year
 * @param {Object} [game] - Optional `Game` header used to retain known team names/scores
 * @returns {Object} Unified box score skeleton with empty player arrays
 */
export function createUnplayedSkeleton(gameId, season, game = null) {
	return {
		gameId,
		season,
		gameDate: game ? parseGameDateTime(game.GameDateTime) : '',
		homeTeam: {
			teamId: '',
			teamName: (game && game.HomeTeamNameE) || 'Unplayed',
			score: game ? toNumber(game.HomeTeamScore) : 0,
			players: []
		},
		awayTeam: {
			teamId: '',
			teamName: (game && game.AwayTeamNameE) || 'Unplayed',
			score: game ? toNumber(game.AwayTeamScore) : 0,
			players: []
		}
	};
}

/**
 * @description Resolves which `PeriodCategory` holds full-game player totals for one side.
 * Prefers the standard full-game category (18) and self-validates against the official final
 * score so overtime or upstream category shifts degrade gracefully instead of silently
 * truncating statistics.
 * @param {Object[]} rows - One side's raw box score rows (`Category=1` player rows)
 * @param {number} expectedScore - Official final score for that side
 * @returns {number} The chosen period category
 */
function resolveFullGamePeriod(rows, expectedScore) {
	const present = [...new Set(rows.map(r => toNumber(r.PeriodCategory)))];
	const ordered = [FULL_GAME_PERIOD, ...present.filter(pc => pc !== FULL_GAME_PERIOD).sort((a, b) => b - a)];
	for (const periodCategory of ordered) {
		if (!present.includes(periodCategory)) {
			continue;
		}
		const sum = rows
			.filter(r => toNumber(r.PeriodCategory) === periodCategory && r.TeamID)
			.reduce((acc, r) => acc + toNumber(r.Point), 0);
		if (sum === expectedScore) {
			return periodCategory;
		}
	}
	return present.includes(FULL_GAME_PERIOD) ? FULL_GAME_PERIOD : (ordered.find(pc => present.includes(pc)) ?? FULL_GAME_PERIOD);
}

/**
 * @description Maps one side's full-game player rows into unified player statistics.
 * @param {Object[]} rows - Raw box score rows for one side
 * @param {number} expectedScore - Official final score used to validate period selection
 * @returns {Object[]} Unified player entries (empty when the side has no box score)
 */
function parseTeamPlayers(rows, expectedScore) {
	if (!Array.isArray(rows) || rows.length === 0) {
		return [];
	}
	const playerRows = rows.filter(r => toNumber(r.Category) === 1 && r.TeamID);
	if (playerRows.length === 0) {
		return [];
	}
	const periodCategory = resolveFullGamePeriod(playerRows, expectedScore);
	const fullGameRows = playerRows.filter(r => toNumber(r.PeriodCategory) === periodCategory);

	return fullGameRows.map(row => {
		const pt2m = toNumber(row.PT2M);
		const pt3m = toNumber(row.PT3M);
		return {
			playerId: String(row.PlayerID ?? '').trim(),
			playerName: String(row.PlayerNameE || row.PlayerNameJ || '').trim(),
			statistics: {
				min: String(row.PlayTime ?? '00:00'),
				pts: toNumber(row.Point),
				fgm: pt2m + pt3m,
				fga: toNumber(row.PT2A) + toNumber(row.PT3A),
				fg3m: pt3m,
				fg3a: toNumber(row.PT3A),
				ftm: toNumber(row.FTM),
				fta: toNumber(row.FTA),
				oreb: toNumber(row.RB_OFF),
				dreb: toNumber(row.RB_DEF),
				reb: toNumber(row.RB_TOT),
				ast: toNumber(row.AS),
				stl: toNumber(row.ST),
				blk: toNumber(row.BS),
				tov: toNumber(row.TO),
				pf: toNumber(row.FOUL),
				plus_minus: toNumber(row.PLUSMINUS)
			}
		};
	});
}

/**
 * @description Parses an official B.League game payload into the unified box score shape.
 * Returns an unplayed skeleton when the game has not ended or carries no box score rows
 * (future fixtures, postponed games, and boxscore-less exhibition games).
 * @param {Object} payload - Raw game payload (`Game`, `HomeBoxscores`, `AwayBoxscores`, ...)
 * @param {string} gameId - Unified game identifier (e.g. `BLEAGUE2024_502710`)
 * @param {string} season - Season start year
 * @returns {Object} Unified box score object
 * @throws {Error} If the payload is not an object
 */
export function parseBLeaguePayload(payload, gameId, season) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error(`[BLeagueParser] Payload for ${gameId} is not an object.`);
	}

	const game = payload.Game && typeof payload.Game === 'object' ? payload.Game : null;
	if (!game) {
		return createUnplayedSkeleton(gameId, season);
	}

	const gameEnded = game.GameEndedFlg === true || game.GameEndedFlg === 1;
	if (!gameEnded) {
		// Live or not-yet-started: never cache partial statistics as final.
		return createUnplayedSkeleton(gameId, season);
	}

	const homeScore = toNumber(game.HomeTeamScore);
	const awayScore = toNumber(game.AwayTeamScore);
	const homePlayers = parseTeamPlayers(payload.HomeBoxscores, homeScore);
	const awayPlayers = parseTeamPlayers(payload.AwayBoxscores, awayScore);

	if (homePlayers.length === 0 && awayPlayers.length === 0) {
		// Finished game without box score rows (e.g. exhibition games with `box: 0`).
		return createUnplayedSkeleton(gameId, season, game);
	}

	return {
		gameId,
		season,
		gameDate: parseGameDateTime(game.GameDateTime),
		homeTeam: {
			teamId: String(game.HomeTeamShortNameE || game.HomeTeamID || '').trim(),
			teamName: String(game.HomeTeamNameE || game.HomeTeamNameJ || '').trim(),
			score: homeScore,
			players: homePlayers
		},
		awayTeam: {
			teamId: String(game.AwayTeamShortNameE || game.AwayTeamID || '').trim(),
			teamName: String(game.AwayTeamNameE || game.AwayTeamNameJ || '').trim(),
			score: awayScore,
			players: awayPlayers
		}
	};
}

/**
 * @description Extracts the JSON object assigned to `_contexts_s3id.data` from `game_detail` HTML.
 * This is the same-source fallback transport used when the S3 bucket denies access.
 * @param {string} html - Raw `game_detail` page HTML
 * @returns {Object|null} The embedded payload, or null when absent/unparseable
 */
export function extractEmbeddedPayload(html) {
	if (typeof html !== 'string' || html === '') {
		return null;
	}
	EMBED_ANCHOR.lastIndex = 0;
	let match = EMBED_ANCHOR.exec(html);
	while (match !== null) {
		const start = match.index + match[0].length;
		if (html[start] === '{') {
			let depth = 0;
			let inString = false;
			let escaped = false;
			for (let i = start; i < html.length; i++) {
				const char = html[i];
				if (inString) {
					if (escaped) {
						escaped = false;
					} else if (char === '\\') {
						escaped = true;
					} else if (char === '"') {
						inString = false;
					}
					continue;
				}
				if (char === '"') {
					inString = true;
				} else if (char === '{') {
					depth += 1;
				} else if (char === '}') {
					depth -= 1;
					if (depth === 0) {
						try {
							return JSON.parse(html.slice(start, i + 1));
						} catch (e) {
							break;
						}
					}
				}
			}
		}
		match = EMBED_ANCHOR.exec(html);
	}
	return null;
}
