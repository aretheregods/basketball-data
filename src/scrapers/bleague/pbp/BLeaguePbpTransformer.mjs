/**
 * @file BLeaguePbpTransformer.mjs
 * @description League-owned transformer that turns the official B.League `v2_genius_contexts`
 * `PlayByPlays` rows into `game_play_by_play` and `game_stints` records.
 *
 * Feed semantics (decoded from the official payloads):
 * - `ActionCD1` is the event code mapped by {@link BLEAGUE_ACTION_TYPES}; `ActionCD2`/`ActionCD3`
 *   are sub-codes surfaced verbatim through `sub_type` as `CD2:CD3`.
 * - `Score` is a post-action `"home-away"` string. Substitution and administrative rows may omit
 *   it (`null`), so the transformer carries the last known score forward.
 * - `RestTime` is the remaining period clock as `M:SS` / `MM:SS` (10:00 FIBA quarters, 5:00 OTs).
 * - `HomeAway` (`1`=home, `2`=away) identifies the acting side. The `Side` column only describes
 *   the court side the team is defending and flips by half, so it is never used for identity.
 * - Rows are ragged: administrative rows carry `Side` but no `HomeAway`, and there is never a
 *   second player column. Paired actors (e.g. an assist) arrive as consecutive rows, so the
 *   assist link is resolved from the most recent made field goal by the same team.
 *
 * Stints are produced in the same single pass: a stint opens on any non-substitution row
 * (administrative rows open/extend but never contribute possessions), closes at a period
 * boundary (anchored on the final row of the old period) or on the first row of a substitution
 * run (so lineups are snapshotted *before* the substitutions apply), and at EOF. A stint is only
 * emitted when it contained a play or a non-empty lineup, which suppresses the degenerate
 * game-start interval that precedes the starting-lineup substitution run.
 */

/**
 * @description Official `ActionCD1` code to standard event type mapping. Codes 20/26/31/91-94
 * are additional foul varieties, 80-88 are game/clock administration, and any code absent from
 * this map falls back to `ACTION_<code>` so unknown future codes remain visible in the data.
 * @type {Readonly<Record<number, string>>}
 */
export const BLEAGUE_ACTION_TYPES = Object.freeze({
	1: '3FGM',
	2: '3FGA',
	3: '2FGM',
	4: '2FGM',
	5: '2FGA',
	6: '2FGA',
	7: 'FTM',
	8: 'FTA',
	9: 'DRB',
	10: 'ORB',
	11: 'BLK',
	12: 'AST',
	13: 'TOV',
	14: 'STL',
	15: 'FOUL_DRAWN',
	16: 'BASKET_COUNT',
	17: 'TEAM_TURNOVER',
	18: 'TEAM_DREB',
	19: 'TEAM_OREB',
	20: 'FOUL_COACH_TECHNICAL',
	21: 'FOUL_BENCH_TECHNICAL',
	22: 'FOUL_PERSONAL',
	23: 'FOUL_OFFENSIVE',
	26: 'FOUL_DISQUALIFYING',
	31: 'FOUL_ON_FREE_THROW',
	80: 'GAME_START',
	81: 'GAME_END',
	82: 'PERIOD_START',
	83: 'PERIOD_END',
	84: 'CLOCK_START',
	85: 'CLOCK_STOP',
	86: 'SUB_IN',
	87: 'SUB_OUT',
	88: 'TIMEOUT',
	91: 'FOUL_TECHNICAL_CAT1',
	92: 'FOUL_TECHNICAL_CAT2',
	93: 'FOUL_FLAGRANT',
	94: 'FOUL_DISRUPTIVE'
});

/**
 * @description Administrative event types (game/period/clock control, substitutions and
 * timeouts). They may open or extend a stint but never count toward its possession estimate.
 * @type {ReadonlySet<string>}
 */
export const BLEAGUE_ADMIN_EVENT_TYPES = Object.freeze(new Set([
	'GAME_START', 'GAME_END', 'PERIOD_START', 'PERIOD_END',
	'CLOCK_START', 'CLOCK_STOP', 'SUB_IN', 'SUB_OUT', 'TIMEOUT'
]));

/**
 * @description Event types whose rows move the scoreboard through their own score change; kept
 * as an explicit fallback for rows whose `Score` string fails to parse.
 * @type {ReadonlySet<string>}
 */
const MADE_SHOT_TYPES = Object.freeze(new Set(['2FGM', '3FGM', 'FTM']));

/** @type {ReadonlySet<string>} Event types counted as a field goal attempt in the possession estimate */
const POSSESSION_FGA_TYPES = Object.freeze(new Set(['2FGA', '3FGA', '2FGM', '3FGM']));

/** @type {ReadonlySet<string>} Event types counted as a free throw attempt in the possession estimate */
const POSSESSION_FTA_TYPES = Object.freeze(new Set(['FTA', 'FTM']));

/**
 * @description Open stint accumulator tracked during the single transformation pass.
 * @typedef {Object} BLeagueOpenStint
 * @property {number} period - Period the stint belongs to
 * @property {string} startClock - Clock string when the stint opened
 * @property {number} startSecs - Seconds remaining in period when the stint opened
 * @property {number} startHome - Home score when the stint opened
 * @property {number} startAway - Away score when the stint opened
 * @property {number} fga - Field goal attempts (makes included) inside the stint
 * @property {number} fta - Free throw attempts (makes included) inside the stint
 * @property {number} oreb - Offensive rebounds inside the stint
 * @property {number} tov - Turnovers inside the stint
 * @property {boolean} hasPlay - True once a non-administrative row was seen in the stint
 */

/**
 * @description Parses the B.League remaining-clock string (`M:SS`, `MM:SS` or `MM:SS.s`) into
 * seconds remaining in the period. Numeric input is passed through and unparseable input
 * resolves to 0 so a malformed clock can never crash a transformation run.
 * @param {string|number|null|undefined} clockStr - Raw `RestTime` value (e.g. '9:45', '10:00')
 * @returns {number} Seconds remaining in the current period (e.g. '9:45' -> 585)
 */
export function parseBLeagueClockToSeconds(clockStr) {
	if (typeof clockStr === 'number') {
		return Number.isFinite(clockStr) ? clockStr : 0;
	}
	if (clockStr === null || clockStr === undefined) return 0;

	const text = String(clockStr).trim();
	if (!text) return 0;

	if (text.includes(':')) {
		const [minutesRaw, secondsRaw] = text.split(':');
		const minutes = Number(minutesRaw);
		const seconds = Number(secondsRaw);
		const total = (Number.isFinite(minutes) ? minutes : 0) * 60 + (Number.isFinite(seconds) ? seconds : 0);
		return Number(total.toFixed(2));
	}

	const asNumber = Number(text);
	return Number.isFinite(asNumber) ? Number(asNumber.toFixed(2)) : 0;
}

/**
 * @description Converts period-local seconds remaining into game seconds remaining using the
 * NBL/FIBA convention: regulation periods (1-4) count down from 2400s, overtimes report their
 * own period clock (an OT starting 5:00 remaining reports 300).
 * @param {number} period - Period number (1-4 regulation, 5+ overtime)
 * @param {number} secondsInPeriod - Seconds remaining inside the period
 * @returns {number} Game seconds remaining
 */
export function calculateGameSecondsRemaining(period, secondsInPeriod) {
	const safePeriod = Number(period) || 1;
	const safeSecs = Number(secondsInPeriod) || 0;

	if (safePeriod <= 4) {
		return Number((((4 - safePeriod) * 600) + safeSecs).toFixed(2));
	}
	return Number(safeSecs.toFixed(2));
}

/**
 * @description Parses the post-action `"home-away"` score string carried on every scored row.
 * @param {string|null|undefined} scoreRaw - Raw `Score` value (e.g. '42-56')
 * @returns {{home: number, away: number}|null} Parsed score, or null when the row omits/invalidates it
 */
export function parseBLeagueScore(scoreRaw) {
	if (typeof scoreRaw !== 'string') return null;
	const parts = scoreRaw.split('-');
	if (parts.length !== 2) return null;

	const home = Number.parseInt(parts[0], 10);
	const away = Number.parseInt(parts[1], 10);
	if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
	return { home, away };
}

/**
 * @description Resolves which side of the scoreboard acted on a row. `HomeAway` is authoritative;
 * the team IDs from the `Game` header are used as a fallback for ragged rows that omit it.
 * The court `Side` column is intentionally ignored because it flips at half time.
 * @param {Record<string, any>} row - Raw play row
 * @param {string|null} teamId - Row team ID (already normalized to string)
 * @param {string|null} homeTeamId - Home team ID from the `Game` header
 * @param {string|null} awayTeamId - Away team ID from the `Game` header
 * @returns {'home'|'away'|null} Scoreboard side, or null for neutral/administrative rows
 */
function resolveSide(row, teamId, homeTeamId, awayTeamId) {
	const homeAway = Number(row.HomeAway);
	if (homeAway === 1) return 'home';
	if (homeAway === 2) return 'away';
	if (teamId && homeTeamId && teamId === homeTeamId) return 'home';
	if (teamId && awayTeamId && teamId === awayTeamId) return 'away';
	return null;
}

/**
 * @description Builds the `sub_type` composite from the `ActionCD2`/`ActionCD3` sub-codes
 * (e.g. `30` for a personal foul with only `ActionCD2=30`, `35:48` when both exist). Rows
 * without sub-codes map to null.
 * @param {Record<string, any>} row - Raw play row
 * @returns {string|null} Composite sub-code or null
 */
function buildSubType(row) {
	const code2 = row.ActionCD2;
	const code3 = row.ActionCD3;
	if ((code2 === null || code2 === undefined) && (code3 === null || code3 === undefined)) {
		return null;
	}
	return `${code2 ?? ''}:${code3 ?? ''}`;
}

/**
 * @description Transforms the official B.League play-by-play payload into database-ready event
 * and stint rows using a single chronological pass.
 * @param {string} gameId - Unified game identifier (e.g. `BLEAGUE2026_506379`)
 * @param {Object} rawJson - Raw `v2_genius_contexts` payload containing `PlayByPlays`
 * @param {string|null} [competitionId=null] - Competition identifier stamped onto every row
 * @returns {{events: Record<string, any>[], stints: Record<string, any>[]}} Event and stint rows
 */
export function transformBLeaguePbp(gameId, rawJson, competitionId = null) {
	if (!rawJson || typeof rawJson !== 'object') {
		return { events: [], stints: [] };
	}
	const rows = Array.isArray(rawJson.PlayByPlays) ? rawJson.PlayByPlays : null;
	if (!rows || rows.length === 0) {
		return { events: [], stints: [] };
	}

	const compId = competitionId
		? String(competitionId)
		: (rawJson.competitionId ?? rawJson.competition_id ?? null);
	const gameHeader = (rawJson.Game && typeof rawJson.Game === 'object') ? rawJson.Game : null;
	const homeTeamId = gameHeader?.HomeTeamID !== undefined && gameHeader?.HomeTeamID !== null
		? String(gameHeader.HomeTeamID) : null;
	const awayTeamId = gameHeader?.AwayTeamID !== undefined && gameHeader?.AwayTeamID !== null
		? String(gameHeader.AwayTeamID) : null;

	/** @type {Record<string, any>[]} */
	const events = [];
	/** @type {Record<string, any>[]} */
	const stints = [];

	// Live 5-on-5 lineups. Substitutions are applied only after a stint has been closed so the
	// emitted lineup hash always reflects who was on the court during the interval.
	const lineups = { home: new Set(), away: new Set() };

	/** @type {BLeagueOpenStint|null} */
	let openStint = null;
	let stintIndex = 1;
	/** @type {number|null} Period of the row currently being processed */
	let curPeriod = null;
	let prevWasSub = false;
	/** @type {{clock: string, secs: number}|null} Previous row, used as the period-boundary anchor */
	let lastRow = null;
	let runningHome = 0;
	let runningAway = 0;
	let prevRowHome = 0;
	let prevRowAway = 0;
	/** @type {{teamId: string|null, playerId: string|null}|null} Made shooter awaiting its assist row */
	let lastScorer = null;

	/**
	 * @description Closes the open stint at `anchorRow`, emits it when it satisfies the guard,
	 * and resets the accumulator. Lineups are snapshotted here, before any substitution applies.
	 * @param {{clock: string, secs: number}|null} anchorRow - Row whose clock ends the stint
	 * @returns {void}
	 */
	const closeStint = (anchorRow) => {
		if (!openStint || !anchorRow) return;

		const homePlayers = Array.from(lineups.home).sort();
		const awayPlayers = Array.from(lineups.away).sort();
		const emitted = openStint.hasPlay || homePlayers.length > 0 || awayPlayers.length > 0;
		if (emitted) {
			const duration = Math.max(0, Number((openStint.startSecs - anchorRow.secs).toFixed(2)));
			const possessions = Math.max(
				0,
				Number((openStint.fga + (0.44 * openStint.fta) - openStint.oreb + openStint.tov).toFixed(1))
			);
			stints.push({
				stint_id: `${gameId}_stint_${openStint.period}_${stintIndex}`,
				game_id: String(gameId),
				competition_id: compId,
				period: Number(openStint.period),
				start_clock: openStint.startClock,
				end_clock: anchorRow.clock,
				duration_seconds: duration,
				home_lineup_hash: JSON.stringify(homePlayers),
				away_lineup_hash: JSON.stringify(awayPlayers),
				home_pts: runningHome - openStint.startHome,
				away_pts: runningAway - openStint.startAway,
				possessions
			});
			stintIndex++;
		}
		openStint = null;
	};

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const period = Number.parseInt(row.Period, 10) || 1;
		const clock = row.RestTime !== null && row.RestTime !== undefined ? String(row.RestTime) : '';
		const secs = parseBLeagueClockToSeconds(clock);
		const gameSecs = calculateGameSecondsRemaining(period, secs);
		const eventType = BLEAGUE_ACTION_TYPES[row.ActionCD1] ?? `ACTION_${row.ActionCD1}`;
		const isSub = eventType === 'SUB_IN' || eventType === 'SUB_OUT';
		const isAdmin = BLEAGUE_ADMIN_EVENT_TYPES.has(eventType);
		const teamId = row.TeamID !== null && row.TeamID !== undefined && row.TeamID !== '' ? String(row.TeamID) : null;
		const playerId = row.PlayerID1 !== null && row.PlayerID1 !== undefined && row.PlayerID1 !== ''
			? String(row.PlayerID1) : null;
		const side = resolveSide(row, teamId, homeTeamId, awayTeamId);

		// 1. Period boundary: close the previous period's final stint on its last row, before
		//    the current (new period) row mutates the running score.
		if (curPeriod === null) {
			curPeriod = period;
		} else if (period !== curPeriod) {
			closeStint(lastRow);
			curPeriod = period;
			stintIndex = 1;
			lastScorer = null;
			prevWasSub = false;
		}

		// 2. Apply this row's post-action score to the running totals.
		const parsedScore = parseBLeagueScore(row.Score);
		if (parsedScore) {
			runningHome = parsedScore.home;
			runningAway = parsedScore.away;
		}

		// 3. Substitution runs (consecutive SUB_IN/SUB_OUT rows) close the stint before any
		//    lineup change applies, so the emitted lineups are the pre-substitution units.
		if (isSub && !prevWasSub) {
			closeStint({ clock, secs });
		}

		// 4. Any row opens a fresh stint when none is open (administrative rows included).
		if (!openStint) {
			openStint = {
				period: curPeriod,
				startClock: clock,
				startSecs: secs,
				startHome: runningHome,
				startAway: runningAway,
				fga: 0,
				fta: 0,
				oreb: 0,
				tov: 0,
				hasPlay: false
			};
		}

		// 5. Apply substitutions only after the potential close above.
		if (isSub) {
			if (side && playerId) {
				const lineup = side === 'home' ? lineups.home : lineups.away;
				if (eventType === 'SUB_IN') lineup.add(playerId);
				else lineup.delete(playerId);
			}
		} else if (!isAdmin) {
			openStint.hasPlay = true;
			if (POSSESSION_FGA_TYPES.has(eventType)) openStint.fga++;
			else if (POSSESSION_FTA_TYPES.has(eventType)) openStint.fta++;
			else if (eventType === 'ORB') openStint.oreb++;
			else if (eventType === 'TOV') openStint.tov++;
		}

		// 6. Resolve the assist link from the most recent made field goal by the same team.
		//    The link is single-use: consuming it (or a period change) clears it.
		let secondaryPlayerId = null;
		if (eventType === 'AST') {
			if (lastScorer && lastScorer.teamId && lastScorer.teamId === teamId
				&& lastScorer.playerId && lastScorer.playerId !== playerId) {
				secondaryPlayerId = lastScorer.playerId;
			}
			lastScorer = null;
		}

		const scoreChanged = runningHome !== prevRowHome || runningAway !== prevRowAway;
		const isScoring = scoreChanged || MADE_SHOT_TYPES.has(eventType);

		events.push({
			event_id: `${gameId}_${row.No ?? i}_${i}`,
			game_id: String(gameId),
			competition_id: compId,
			period: Number(period),
			clock,
			seconds_remaining: secs,
			game_seconds_remaining: gameSecs,
			event_type: eventType,
			sub_type: buildSubType(row),
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: secondaryPlayerId,
			description: String(row.PlayText ?? '').trim(),
			home_score: runningHome,
			away_score: runningAway,
			loc_x: (row.X !== null && row.X !== undefined && Number.isFinite(Number(row.X))) ? Number(row.X) : null,
			loc_y: (row.Y !== null && row.Y !== undefined && Number.isFinite(Number(row.Y))) ? Number(row.Y) : null,
			shot_distance: null,
			is_scoring_play: isScoring ? 1 : 0
		});

		// 7. Track the made shooter so a following assist row can credit him.
		if (eventType === '2FGM' || eventType === '3FGM') {
			lastScorer = { teamId, playerId };
		}

		prevRowHome = runningHome;
		prevRowAway = runningAway;
		lastRow = { clock, secs };
		prevWasSub = isSub;
	}

	// 8. EOF: close any stint still open, anchored on the final row.
	closeStint(lastRow);

	return { events, stints };
}
