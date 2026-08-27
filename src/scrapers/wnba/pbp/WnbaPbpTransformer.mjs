/**
 * @description Clock converter utility. Converts ISO 8601 duration string (e.g., "PT08M45.00S")
 * or standard clock string ("08:45") into total seconds remaining in period.
 * @param {string} clockStr - Clock string from event
 * @param {number} period - Quarter or OT period
 * @returns {number} - Seconds remaining in current period
 */
export function parseClockToSeconds(clockStr, period) {
	if (!clockStr) return 0;
	let min = 0;
	let sec = 0;

	if (typeof clockStr === 'string' && clockStr.startsWith('PT')) {
		// ISO 8601 duration format e.g. PT08M45.00S or PT08M45S
		const minMatch = clockStr.match(/PT(\d+)M/);
		const secMatch = clockStr.match(/M(\d+(?:\.\d+)?)S/) || clockStr.match(/PT(\d+(?:\.\d+)?)S/);
		if (minMatch) min = parseFloat(minMatch[1]);
		if (secMatch) sec = parseFloat(secMatch[1]);
	} else if (typeof clockStr === 'string' && clockStr.includes(':')) {
		const parts = clockStr.split(':').map(Number);
		min = parts[0] || 0;
		sec = parts[1] || 0;
	} else {
		sec = parseFloat(clockStr) || 0;
	}

	return Number((min * 60 + sec).toFixed(2));
}

/**
 * @description Helper to format seconds back to MM:SS string
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatSecondsToClock(totalSeconds) {
	const mins = Math.floor(totalSeconds / 60);
	const secs = Math.floor(totalSeconds % 60);
	return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * @description Normalizes raw action object from CDN JSON or Stats API rowSet into flat event structure.
 * @param {string} gameId
 * @param {Object|Array} action
 * @param {number} index
 * @param {Record<string, number>} [headerMap] - Optional map if action is Stats API array row
 * @returns {Object}
 */
function parseRawAction(gameId, action, index, headerMap = null) {
	let actionNumber, period, clock, eventType, subType, teamId, playerId, secondaryPlayerId;
	let description, homeScore, awayScore, locX, locY, shotDistance, isScoringPlay;

	if (Array.isArray(action) && headerMap) {
		// Stats API rowSet array
		actionNumber = action[headerMap['EVENTNUM']];
		period = action[headerMap['PERIOD']];
		clock = action[headerMap['PCTIMESTRING']];
		eventType = action[headerMap['EVENTMSGTYPE']];
		subType = action[headerMap['EVENTMSGACTIONTYPE']];
		teamId = action[headerMap['PLAYER1_TEAM_ID']] ? String(action[headerMap['PLAYER1_TEAM_ID']]) : null;
		playerId = action[headerMap['PLAYER1_ID']] ? String(action[headerMap['PLAYER1_ID']]) : null;
		secondaryPlayerId = action[headerMap['PLAYER2_ID']] ? String(action[headerMap['PLAYER2_ID']]) : null;

		const homeDesc = action[headerMap['HOMEDESCRIPTION']] || '';
		const neutralDesc = action[headerMap['NEUTRALDESCRIPTION']] || '';
		const visitorDesc = action[headerMap['VISITORDESCRIPTION']] || '';
		description = [homeDesc, neutralDesc, visitorDesc].filter(Boolean).join(' | ');

		const scoreStr = action[headerMap['SCORE']];
		if (scoreStr && scoreStr.includes('-')) {
			const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
			// Stats API SCORE format is "VISITOR - HOME" or "HOME - VISITOR" (typically AWAY - HOME or HOME - AWAY)
			// Standard Stats API boxscores format SCORE column as "VISITOR - HOME" (e.g. 2 - 0 = Away 2, Home 0 or Home 2, Away 0)
			// In standard WNBA Stats API: 1st number = Visitor (Away), 2nd number = Home
			awayScore = parts[0] || 0;
			homeScore = parts[1] || 0;
		} else {
			homeScore = 0;
			awayScore = 0;
		}

		locX = null;
		locY = null;
		shotDistance = null;
		isScoringPlay = (eventType === 1 || (eventType === 3 && scoreStr)) ? 1 : 0;
	} else {
		// CDN Live JSON object
		actionNumber = action.actionId ?? action.actionNumber ?? index + 1;
		period = action.period ?? 1;

		const rawClock = action.clock ?? "10:00";
		if (typeof rawClock === 'string' && rawClock.startsWith('PT')) {
			const secs = parseClockToSeconds(rawClock, period);
			clock = formatSecondsToClock(secs);
		} else {
			clock = String(rawClock);
		}

		eventType = action.actionType ?? action.eventMsgType ?? 0;
		subType = action.subType ?? action.actionSubtype ?? null;
		teamId = action.teamId ? String(action.teamId) : null;
		playerId = action.personId ? String(action.personId) : (action.playerId ? String(action.playerId) : null);
		secondaryPlayerId = action.assistPersonId || action.blockPersonId || action.foulPersonId || action.person2Id || null;
		if (secondaryPlayerId) secondaryPlayerId = String(secondaryPlayerId);

		description = action.description || action.desc || '';
		homeScore = action.scoreHome ? parseInt(action.scoreHome, 10) : 0;
		awayScore = action.scoreAway ? parseInt(action.scoreAway, 10) : 0;

		locX = action.xLegacy ?? action.x ?? null;
		locY = action.yLegacy ?? action.y ?? null;
		shotDistance = action.shotDistance ?? null;

		isScoringPlay = (action.isFieldGoal === 1 || action.shotResult === 'made' || eventType === 1 || (eventType === 3 && action.shotResult === 'made')) ? 1 : 0;
	}

	const secsRemaining = parseClockToSeconds(clock, period);

	return {
		event_id: `${gameId}_${actionNumber}_${index}`,
		game_id: String(gameId),
		period: Number(period),
		clock: String(clock),
		seconds_remaining: secsRemaining,
		event_type: Number(eventType),
		sub_type: subType !== null ? Number(subType) : null,
		team_id: teamId,
		player_id: playerId,
		secondary_player_id: secondaryPlayerId,
		description: String(description),
		home_score: homeScore,
		away_score: awayScore,
		loc_x: locX !== null ? Number(locX) : null,
		loc_y: locY !== null ? Number(locY) : null,
		shot_distance: shotDistance !== null ? Number(shotDistance) : null,
		is_scoring_play: isScoringPlay ? 1 : 0
	};
}

/**
 * @description Lineup State Machine: processes actions chronologically to partition game into 5-on-5 stints.
 * @param {string} gameId
 * @param {Object[]} events - Cleaned event records sorted by period & time
 * @returns {Object[]} - Array of derived stint records
 */
function buildStintsFromEvents(gameId, events) {
	const stints = [];

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

			// Track possessions indicators
			if (evt.event_type === 1 || evt.event_type === 2) { // Made or Missed Field Goal
				stintFga++;
			} else if (evt.event_type === 3) { // Free Throw
				stintFta++;
			} else if (evt.event_type === 4 && evt.sub_type === 1) { // Offensive Rebound (approx)
				stintOreb++;
			} else if (evt.event_type === 5) { // Turnover
				stintTov++;
			}

			// Track substitutions (Event type 8)
			const isSub = (evt.event_type === 8);

			if (isSub || i === pEvents.length - 1) {
				const durationSecs = Math.max(0, stintStartSecs - evt.seconds_remaining);

				// Calculate estimated stint possessions: FGA + 0.44 * FTA - OREB + TOV
				const possEst = Math.max(0, Number((stintFga + (0.44 * stintFta) - stintOreb + stintTov).toFixed(1)));

				const homeArray = Array.from(homeLineup).sort();
				const awayArray = Array.from(awayLineup).sort();

				stints.push({
					stint_id: `${gameId}_${period}_${stintIndex}`,
					game_id: String(gameId),
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

			// Update lineup state
			if (evt.player_id) {
				if (evt.event_type === 8) {
					// Sub out player_id, sub in secondary_player_id if available
					if (homeLineup.has(evt.player_id)) {
						homeLineup.delete(evt.player_id);
						if (evt.secondary_player_id) homeLineup.add(evt.secondary_player_id);
					} else if (awayLineup.has(evt.player_id)) {
						awayLineup.delete(evt.player_id);
						if (evt.secondary_player_id) awayLineup.add(evt.secondary_player_id);
					}
				} else {
					// Add active player to on-court set if not already present
					if (homeLineup.size < 5) {
						homeLineup.add(evt.player_id);
					} else if (awayLineup.size < 5 && !homeLineup.has(evt.player_id)) {
						awayLineup.add(evt.player_id);
					}
				}
			}
		}
	}

	return stints;
}

/**
 * @description Main transformation function for WNBA play-by-play payloads.
 * @param {string} gameId
 * @param {Object} rawJson
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformWnbaPbp(gameId, rawJson) {
	let rawActions = [];
	let headerMap = null;

	if (rawJson.game && Array.isArray(rawJson.game.actions)) {
		rawActions = rawJson.game.actions;
	} else if (Array.isArray(rawJson.resultSets) && rawJson.resultSets.length > 0) {
		const rSet = rawJson.resultSets[0];
		if (Array.isArray(rSet.headers) && Array.isArray(rSet.rowSet)) {
			headerMap = {};
			rSet.headers.forEach((h, idx) => {
				headerMap[h] = idx;
			});
			rawActions = rSet.rowSet;
		}
	}

	const events = rawActions.map((action, index) => parseRawAction(gameId, action, index, headerMap));

	// Carry over cumulative score if raw payload actions omit score on non-scoring plays
	let currentHomeScore = 0;
	let currentAwayScore = 0;
	for (const evt of events) {
		if (evt.home_score > currentHomeScore) currentHomeScore = evt.home_score;
		else evt.home_score = currentHomeScore;

		if (evt.away_score > currentAwayScore) currentAwayScore = evt.away_score;
		else evt.away_score = currentAwayScore;
	}

	const stints = buildStintsFromEvents(gameId, events);

	return { events, stints };
}
