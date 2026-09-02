/**
 * @description FIBA Rules: Periods 1-4 are 10 minutes (600 seconds); Overtime (Period 5+) is 5 minutes (300 seconds).
 * Calculates total regulation/OT clock in seconds remaining.
 * @param {number} period - Quarter or OT period (1-based)
 * @param {number} secondsInPeriod - Seconds remaining in current period
 * @returns {number}
 */
export function calculateGameSecondsRemaining(period, secondsInPeriod) {
	if (period <= 4) {
		return ((4 - period) * 600) + secondsInPeriod;
	}
	return secondsInPeriod;
}

/**
 * @description Parses EuroLeague clock strings (e.g. "08:45") or minute markers into period seconds remaining.
 * @param {string|number} minuteStr - Minute marker
 * @param {string} rawClock - Standard clock string ("MM:SS")
 * @returns {number}
 */
export function parseEuroClock(minuteStr, rawClock) {
	if (rawClock && typeof rawClock === 'string' && rawClock.includes(':')) {
		const [m, s] = rawClock.split(':').map(Number);
		if (!isNaN(m) && !isNaN(s)) {
			return (m * 60) + s;
		}
	}
	// Fallback estimation if raw clock is omitted
	const min = parseInt(String(minuteStr || '10'), 10);
	if (!isNaN(min)) {
		return Math.max(0, 600 - (min * 60));
	}
	return 0;
}

/**
 * @description Lineup State Machine for EuroLeague PBP events.
 * Partitions period events into 5-on-5 stint intervals.
 * @param {string} gameId
 * @param {string} seasonCode
 * @param {Object[]} events
 * @returns {Object[]}
 */
function buildStintsFromEvents(gameId, seasonCode, events) {
	const stints = [];

	// Determine home and away team IDs from event streams
	let homeTeamId = null;
	let awayTeamId = null;

	for (const evt of events) {
		if (evt.team_id) {
			if (!homeTeamId) {
				homeTeamId = evt.team_id;
			} else if (!awayTeamId && evt.team_id !== homeTeamId) {
				awayTeamId = evt.team_id;
			}
		}
		if (homeTeamId && awayTeamId) break;
	}

	// Group events by period
	const periodMap = new Map();
	for (const evt of events) {
		if (!periodMap.has(evt.period)) {
			periodMap.set(evt.period, []);
		}
		periodMap.get(evt.period).push(evt);
	}

	for (const [period, pEvents] of periodMap.entries()) {
		let stintIndex = 1;
		let homeLineup = new Set();
		let awayLineup = new Set();

		let stintStartClock = pEvents[0]?.clock || (period <= 4 ? "10:00" : "05:00");
		let stintStartSecs = pEvents[0]?.seconds_remaining ?? (period <= 4 ? 600 : 300);
		let stintStartHomePts = pEvents[0]?.home_score || 0;
		let stintStartAwayPts = pEvents[0]?.away_score || 0;
		let stintFga = 0;
		let stintFta = 0;
		let stintOreb = 0;
		let stintTov = 0;

		let runningHomeScore = stintStartHomePts;
		let runningAwayScore = stintStartAwayPts;

		for (let i = 0; i < pEvents.length; i++) {
			const evt = pEvents[i];

			if (evt.home_score > 0) runningHomeScore = evt.home_score;
			if (evt.away_score > 0) runningAwayScore = evt.away_score;

			const typeUpper = String(evt.event_type || '').toUpperCase();

			if (['2FGM', '2FGA', '3FGM', '3FGA', 'FGM', 'FGA'].some(t => typeUpper.includes(t))) {
				stintFga++;
			} else if (['FTM', 'FTA', 'FT'].some(t => typeUpper.includes(t))) {
				stintFta++;
			} else if (['O3FGM', 'O2FGM', 'OFFENSE_REBOUND', 'OREB'].some(t => typeUpper.includes(t))) {
				stintOreb++;
			} else if (['TO', 'TURNOVER'].some(t => typeUpper.includes(t))) {
				stintTov++;
			}

			const isSub = typeUpper === 'SUB' || String(evt.sub_type || '').toUpperCase() === 'IN' || String(evt.sub_type || '').toUpperCase() === 'OUT';

			if (isSub || i === pEvents.length - 1) {
				const durationSecs = Math.max(0, stintStartSecs - evt.seconds_remaining);

				const possEst = Math.max(0, Number((stintFga + (0.44 * stintFta) - stintOreb + stintTov).toFixed(1)));

				const homeArray = Array.from(homeLineup).sort();
				const awayArray = Array.from(awayLineup).sort();

				stints.push({
					stint_id: `${seasonCode}_${gameId}_stint_${period}_${stintIndex}`,
					game_id: String(gameId),
					competition_id: seasonCode,
					period: Number(period),
					start_clock: stintStartClock,
					end_clock: evt.clock,
					duration_seconds: durationSecs,
					home_lineup_hash: JSON.stringify(homeArray),
					away_lineup_hash: JSON.stringify(awayArray),
					home_pts: runningHomeScore - stintStartHomePts,
					away_pts: runningAwayScore - stintStartAwayPts,
					possessions: possEst
				});

				stintIndex++;
				stintStartClock = evt.clock;
				stintStartSecs = evt.seconds_remaining;
				stintStartHomePts = runningHomeScore;
				stintStartAwayPts = runningAwayScore;
				stintFga = 0;
				stintFta = 0;
				stintOreb = 0;
				stintTov = 0;
			}

			if (evt.player_id) {
				const isHome = evt.team_id ? evt.team_id === homeTeamId : homeLineup.has(evt.player_id);
				const isAway = evt.team_id ? evt.team_id === awayTeamId : awayLineup.has(evt.player_id);

				if (isSub) {
					const subType = String(evt.sub_type || '').toUpperCase();
					if (subType === 'OUT') {
						if (isHome) homeLineup.delete(evt.player_id);
						if (isAway) awayLineup.delete(evt.player_id);
					} else {
						if (isHome && homeLineup.size < 5) homeLineup.add(evt.player_id);
						else if (isAway && awayLineup.size < 5) awayLineup.add(evt.player_id);
						else if (!isHome && !isAway) {
							if (homeLineup.size < 5) homeLineup.add(evt.player_id);
							else if (awayLineup.size < 5) awayLineup.add(evt.player_id);
						}
					}
					if (evt.secondary_player_id && subType === 'IN') {
						if (homeLineup.has(evt.secondary_player_id)) homeLineup.add(evt.player_id);
						else if (awayLineup.has(evt.secondary_player_id)) awayLineup.add(evt.player_id);
					}
				} else {
					if (isHome) {
						if (homeLineup.size < 5) homeLineup.add(evt.player_id);
					} else if (isAway) {
						if (awayLineup.size < 5) awayLineup.add(evt.player_id);
					} else {
						if (homeLineup.size < 5) homeLineup.add(evt.player_id);
						else if (awayLineup.size < 5) awayLineup.add(evt.player_id);
					}
				}
			}
		}
	}

	return stints;
}

/**
 * @description Main transformation function for EuroLeague / EuroCup raw PBP JSON payloads.
 * @param {string} gameCode
 * @param {Object} rawJson
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformEuroleaguePbp(gameCode, rawJson) {
	if (!rawJson) return { events: [], stints: [] };

	let rawEvents = [];
	if (rawJson.pbp) {
		rawEvents = Array.isArray(rawJson.pbp.Rows) ? rawJson.pbp.Rows : (Array.isArray(rawJson.pbp) ? rawJson.pbp : []);
	} else if (Array.isArray(rawJson.Rows)) {
		rawEvents = rawJson.Rows;
	} else if (Array.isArray(rawJson)) {
		rawEvents = rawJson;
	}

	const seasonCode = rawJson.seasonCode || rawJson.competition_id || (String(gameCode).includes('U') ? 'U2024' : 'E2024');

	const pointsMap = new Map();
	if (rawJson.points && Array.isArray(rawJson.points.Rows)) {
		for (const pt of rawJson.points.Rows) {
			if (pt.NUM_ANOT !== undefined) {
				pointsMap.set(pt.NUM_ANOT, {
					x: pt.COORD_X ?? pt.x ?? null,
					y: pt.COORD_Y ?? pt.y ?? null,
					distance: pt.DISTANCE ?? pt.distance ?? null
				});
			}
		}
	}

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < rawEvents.length; i++) {
		const action = rawEvents[i];

		const period = parseInt(action.PERIOD || action.period || 1, 10);
		const clockRaw = action.MARKERTIME || action.CLOCK || action.clock || "10:00";
		const secondsRemaining = parseEuroClock(action.MINUTE, clockRaw);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.POINTS_A !== undefined && action.POINTS_A !== null) runningHomeScore = parseInt(action.POINTS_A, 10);
		else if (action.home_score !== undefined && action.home_score !== null) runningHomeScore = parseInt(action.home_score, 10);

		if (action.POINTS_B !== undefined && action.POINTS_B !== null) runningAwayScore = parseInt(action.POINTS_B, 10);
		else if (action.away_score !== undefined && action.away_score !== null) runningAwayScore = parseInt(action.away_score, 10);

		const playNumber = action.NUMBEROFPLAY ?? action.playNumber ?? (i + 1);
		const shotCoords = pointsMap.get(playNumber) || {};
		const playType = action.PLAYTYPE || action.ID_ACTION || action.event_type || '';

		const isScoring = ['2FGM', '3FGM', 'FTM', 'O2FGM', 'O3FGM', 'D2FGM', 'D3FGM'].includes(String(playType).toUpperCase()) || Number(action.POINTS || action.points || 0) > 0;

		events.push({
			event_id: `${seasonCode}_${gameCode}_pbp_${playNumber}_${i}`,
			game_id: String(gameCode),
			competition_id: seasonCode,
			period,
			clock: String(clockRaw),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: String(playType),
			sub_type: action.TYPE ? String(action.TYPE) : null,
			team_id: action.TEAM ? String(action.TEAM) : null,
			player_id: action.PLAYER_ID ? String(action.PLAYER_ID) : null,
			secondary_player_id: action.PASSING_PLAYER_ID || action.BLOCK_PLAYER_ID || null,
			description: String(action.PLAYINFO || action.COMMENT || action.description || ''),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: (shotCoords.x !== null && shotCoords.x !== undefined) ? Number(shotCoords.x) : null,
			loc_y: (shotCoords.y !== null && shotCoords.y !== undefined) ? Number(shotCoords.y) : null,
			shot_distance: (shotCoords.distance !== null && shotCoords.distance !== undefined) ? Number(shotCoords.distance) : null,
			is_scoring_play: isScoring ? 1 : 0
		});
	}

	const stints = buildStintsFromEvents(gameCode, seasonCode, events);

	return { events, stints };
}
