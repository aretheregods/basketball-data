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
		// Stats API rowSet array with case-insensitive header lookup
		actionNumber = action[headerMap['EVENTNUM']] ?? action[headerMap['ACTIONID']] ?? action[headerMap['EVENT_NUM']];
		period = action[headerMap['PERIOD']] ?? action[headerMap['PERIODNUM']];
		clock = action[headerMap['PCTIMESTRING']] ?? action[headerMap['CLOCK']] ?? action[headerMap['TIME_REMAINING']];
		eventType = action[headerMap['EVENTMSGTYPE']] ?? action[headerMap['EVENTTYPE']] ?? action[headerMap['ACTIONTYPE']];
		subType = action[headerMap['EVENTMSGACTIONTYPE']] ?? action[headerMap['SUBTYPE']] ?? action[headerMap['ACTIONSUBTYPE']];

		const rawTeamId = action[headerMap['PLAYER1_TEAM_ID']] ?? action[headerMap['TEAM_ID']] ?? action[headerMap['TEAMID']];
		teamId = (rawTeamId !== null && rawTeamId !== undefined) ? String(rawTeamId) : null;

		const rawPlayerId = action[headerMap['PLAYER1_ID']] ?? action[headerMap['PERSON_ID']] ?? action[headerMap['PLAYERID']] ?? action[headerMap['PERSONID']];
		playerId = (rawPlayerId !== null && rawPlayerId !== undefined) ? String(rawPlayerId) : null;

		const rawSecondaryPlayerId = action[headerMap['PLAYER2_ID']] ?? action[headerMap['PERSON2_ID']] ?? action[headerMap['ASSIST_PLAYER_ID']] ?? action[headerMap['BLOCK_PLAYER_ID']];
		secondaryPlayerId = (rawSecondaryPlayerId !== null && rawSecondaryPlayerId !== undefined) ? String(rawSecondaryPlayerId) : null;

		const homeDesc = action[headerMap['HOMEDESCRIPTION']] || action[headerMap['HOMEDESC']] || '';
		const neutralDesc = action[headerMap['NEUTRALDESCRIPTION']] || action[headerMap['NEUTRALDESC']] || '';
		const visitorDesc = action[headerMap['VISITORDESCRIPTION']] || action[headerMap['VISITORDESC']] || '';
		description = [homeDesc, neutralDesc, visitorDesc].filter(Boolean).join(' | ');

		const scoreStr = action[headerMap['SCORE']];
		if (scoreStr && typeof scoreStr === 'string' && scoreStr.includes('-')) {
			const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
			awayScore = isNaN(parts[0]) ? 0 : parts[0];
			homeScore = isNaN(parts[1]) ? 0 : parts[1];
		} else {
			homeScore = parseInt(action[headerMap['SCOREHOME']] ?? action[headerMap['HOME_SCORE']] ?? 0, 10);
			awayScore = parseInt(action[headerMap['SCOREAWAY']] ?? action[headerMap['VISITOR_SCORE']] ?? action[headerMap['AWAY_SCORE']] ?? 0, 10);
		}

		locX = action[headerMap['LOCX']] ?? action[headerMap['LOC_X']] ?? action[headerMap['XLEGACY']] ?? null;
		locY = action[headerMap['LOCY']] ?? action[headerMap['LOC_Y']] ?? action[headerMap['YLEGACY']] ?? null;
		shotDistance = action[headerMap['SHOT_DISTANCE']] ?? action[headerMap['SHOTDISTANCE']] ?? null;
		isScoringPlay = (eventType === 1 || (eventType === 3 && scoreStr)) ? 1 : 0;
	} else if (action && typeof action === 'object') {
		// CDN Live / Stats API JSON object
		actionNumber = action.actionId ?? action.actionNumber ?? action.eventNum ?? action.eventId ?? action.event_num ?? (index + 1);
		period = action.period ?? action.periodNumber ?? action.quarter ?? 1;

		const rawClock = action.clock ?? action.pcTimeString ?? action.timeRemaining ?? action.time_remaining ?? "10:00";
		if (typeof rawClock === 'string' && rawClock.startsWith('PT')) {
			const secs = parseClockToSeconds(rawClock, period);
			clock = formatSecondsToClock(secs);
		} else {
			clock = String(rawClock);
		}

		eventType = action.actionType ?? action.eventMsgType ?? action.eventType ?? action.type ?? action.event_type;
		subType = action.subType ?? action.actionSubtype ?? action.eventMsgActionType ?? action.sub_type ?? null;

		const rawTeamId = action.teamId ?? action.team_id ?? action.player1TeamId ?? action.player1_team_id;
		teamId = (rawTeamId !== null && rawTeamId !== undefined) ? String(rawTeamId) : null;

		const rawPlayerId = action.personId ?? action.playerId ?? action.player_id ?? action.person1Id ?? action.player1Id ?? action.player1_id;
		playerId = (rawPlayerId !== null && rawPlayerId !== undefined) ? String(rawPlayerId) : null;

		const rawSecondaryPlayerId = action.assistPersonId || action.blockPersonId || action.foulPersonId || action.person2Id || action.player2Id || action.secondaryPlayerId || action.player2_id || null;
		secondaryPlayerId = (rawSecondaryPlayerId !== null && rawSecondaryPlayerId !== undefined) ? String(rawSecondaryPlayerId) : null;

		description = action.description || action.desc || action.homeDescription || action.visitorDescription || action.neutralDescription || '';

		const scoreStr = action.score || action.scoreString;
		if (scoreStr && typeof scoreStr === 'string' && scoreStr.includes('-')) {
			const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
			awayScore = isNaN(parts[0]) ? 0 : parts[0];
			homeScore = isNaN(parts[1]) ? 0 : parts[1];
		} else {
			homeScore = action.scoreHome ?? action.homeScore ?? action.score_home ?? 0;
			awayScore = action.scoreAway ?? action.awayScore ?? action.score_away ?? action.scoreVisitor ?? 0;
			homeScore = parseInt(homeScore, 10);
			awayScore = parseInt(awayScore, 10);
		}

		locX = action.xLegacy ?? action.x ?? action.locX ?? action.loc_x ?? null;
		locY = action.yLegacy ?? action.y ?? action.locY ?? action.loc_y ?? null;
		shotDistance = action.shotDistance ?? action.shot_distance ?? null;

		isScoringPlay = (action.isFieldGoal === 1 || action.shotResult === 'made' || eventType === 1 || (eventType === 3 && action.shotResult === 'made')) ? 1 : 0;
	} else {
		actionNumber = index + 1;
		period = 1;
		clock = "10:00";
		eventType = 0;
		subType = null;
		teamId = null;
		playerId = null;
		secondaryPlayerId = null;
		description = '';
		homeScore = 0;
		awayScore = 0;
		locX = null;
		locY = null;
		shotDistance = null;
		isScoringPlay = 0;
	}

	const parsedEventType = Number(eventType);
	const safeEventType = (!isNaN(parsedEventType) && eventType !== null && eventType !== undefined) ? parsedEventType : 0;

	const parsedPeriod = Number(period);
	const safePeriod = (!isNaN(parsedPeriod) && period !== null && period !== undefined) ? parsedPeriod : 1;

	const parsedSubType = Number(subType);
	const safeSubType = (!isNaN(parsedSubType) && subType !== null && subType !== undefined) ? parsedSubType : null;

	const secsRemaining = parseClockToSeconds(clock, safePeriod);

	return {
		event_id: `${gameId}_${actionNumber ?? (index + 1)}_${index}`,
		game_id: String(gameId),
		period: safePeriod,
		clock: String(clock || "00:00"),
		seconds_remaining: isNaN(secsRemaining) ? 0 : secsRemaining,
		event_type: safeEventType,
		sub_type: safeSubType,
		team_id: teamId,
		player_id: playerId,
		secondary_player_id: secondaryPlayerId,
		description: String(description || ''),
		home_score: isNaN(Number(homeScore)) ? 0 : Number(homeScore),
		away_score: isNaN(Number(awayScore)) ? 0 : Number(awayScore),
		loc_x: (locX !== null && locX !== undefined && !isNaN(Number(locX))) ? Number(locX) : null,
		loc_y: (locY !== null && locY !== undefined && !isNaN(Number(locY))) ? Number(locY) : null,
		shot_distance: (shotDistance !== null && shotDistance !== undefined && !isNaN(Number(shotDistance))) ? Number(shotDistance) : null,
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

	if (!rawJson) {
		return { events: [], stints: [] };
	}

	// 1. Direct array payload
	if (Array.isArray(rawJson)) {
		rawActions = rawJson;
	}
	// 2. Standard CDN structure: rawJson.game.actions or rawJson.game.plays
	else if (rawJson.game && (Array.isArray(rawJson.game.actions) || Array.isArray(rawJson.game.plays))) {
		rawActions = rawJson.game.actions || rawJson.game.plays;
	}
	// 3. Top-level action/play/pbp containers
	else if (Array.isArray(rawJson.actions)) {
		rawActions = rawJson.actions;
	} else if (Array.isArray(rawJson.plays)) {
		rawActions = rawJson.plays;
	} else if (Array.isArray(rawJson.playByPlay)) {
		rawActions = rawJson.playByPlay;
	} else if (Array.isArray(rawJson.play_by_play)) {
		rawActions = rawJson.play_by_play;
	}
	// 4. Stats API structure: resultSets array
	else if (Array.isArray(rawJson.resultSets) && rawJson.resultSets.length > 0) {
		const rSet = rawJson.resultSets.find(s => s && s.name && (s.name.toLowerCase().includes('playbyplay') || s.name.toLowerCase().includes('pbp'))) || rawJson.resultSets[0];
		if (rSet && Array.isArray(rSet.headers) && Array.isArray(rSet.rowSet)) {
			headerMap = {};
			rSet.headers.forEach((h, idx) => {
				headerMap[String(h).toUpperCase()] = idx;
			});
			rawActions = rSet.rowSet;
		}
	}
	// 5. Stats API structure: resultSet object
	else if (rawJson.resultSet && Array.isArray(rawJson.resultSet.headers) && Array.isArray(rawJson.resultSet.rowSet)) {
		headerMap = {};
		rawJson.resultSet.headers.forEach((h, idx) => {
			headerMap[String(h).toUpperCase()] = idx;
		});
		rawActions = rawJson.resultSet.rowSet;
	}
	// 6. Generic object values fallback
	else if (typeof rawJson === 'object') {
		for (const key of Object.keys(rawJson)) {
			if (Array.isArray(rawJson[key]) && rawJson[key].length > 0) {
				rawActions = rawJson[key];
				break;
			}
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
