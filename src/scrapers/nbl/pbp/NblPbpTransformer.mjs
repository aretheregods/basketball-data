/**
 * @description Clock converter utility for FIBA LiveStats.
 * Converts FIBA clock strings ("10:00", "08:45.5") or ISO duration ("PT10M00S") into seconds remaining in period.
 * @param {string} clockStr
 * @param {number} [period=1]
 * @returns {number}
 */
export function parseFibaClockToSeconds(clockStr, period = 1) {
	if (!clockStr) return 0;
	if (typeof clockStr === 'number') return clockStr;

	let min = 0;
	let sec = 0;

	if (typeof clockStr === 'string' && clockStr.startsWith('PT')) {
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
 * @description Calculates total game seconds remaining for FIBA 10-minute quarters (600s) & 5-minute OTs (300s).
 * @param {number} period - Quarter (1-4) or OT (5+)
 * @param {number} secondsInPeriod
 * @returns {number}
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
 * @description State Machine to group events by period and track substitutions into 5-on-5 stint intervals.
 * @param {string} gameId
 * @param {Object[]} events
 * @returns {Object[]}
 */
function buildStintsFromEvents(gameId, events) {
	const stints = [];
	const periodMap = new Map();

	// Determine unique team IDs from events (first teamSeen is homeTeamId if present)
	const teamIds = [];
	for (const evt of events) {
		if (evt.team_id && !teamIds.includes(evt.team_id)) {
			teamIds.push(evt.team_id);
		}
	}
	const homeTeamId = teamIds[0] || null;
	const awayTeamId = teamIds[1] || null;

	for (const evt of events) {
		if (!periodMap.has(evt.period)) {
			periodMap.set(evt.period, []);
		}
		periodMap.get(evt.period).push(evt);
	}

	for (const [period, pEvents] of periodMap.entries()) {
		let stintIndex = 1;
		const homeLineup = new Set();
		const awayLineup = new Set();

		const defaultStartSecs = period <= 4 ? 600 : 300;
		const defaultStartClock = period <= 4 ? "10:00" : "05:00";

		let stintStartClock = pEvents[0]?.clock || defaultStartClock;
		let stintStartSecs = pEvents[0]?.seconds_remaining ?? defaultStartSecs;
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

			const typeStr = String(evt.event_type || '').toLowerCase();
			const isFieldGoal = typeStr.includes('shot') || typeStr === '1' || typeStr === '2' || typeStr.includes('field goal');
			const isFreeThrow = typeStr.includes('free') || typeStr.includes('ft') || typeStr === '3';
			const isRebound = typeStr.includes('rebound') || typeStr === '4';
			const isTurnover = typeStr.includes('turnover') || typeStr === '5';
			const isSub = typeStr.includes('sub') || typeStr === '8';

			if (isFieldGoal) stintFga++;
			else if (isFreeThrow) stintFta++;
			else if (isRebound && String(evt.sub_type || '').toLowerCase().includes('off')) stintOreb++;
			else if (isTurnover) stintTov++;

			if (isSub || i === pEvents.length - 1) {
				const durationSecs = Math.max(0, Number((stintStartSecs - evt.seconds_remaining).toFixed(2)));
				const possEst = Math.max(0, Number((stintFga + (0.44 * stintFta) - stintOreb + stintTov).toFixed(1)));

				const homeArray = Array.from(homeLineup).sort();
				const awayArray = Array.from(awayLineup).sort();

				stints.push({
					stint_id: `${gameId}_stint_${period}_${stintIndex}`,
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

			if (evt.player_id) {
				const isHomePlayer = (homeTeamId && evt.team_id === homeTeamId) || homeLineup.has(evt.player_id) || (!awayLineup.has(evt.player_id) && homeLineup.size < 5);

				if (isSub) {
					if (isHomePlayer || homeLineup.has(evt.player_id)) {
						homeLineup.delete(evt.player_id);
						if (evt.secondary_player_id) homeLineup.add(evt.secondary_player_id);
					} else {
						awayLineup.delete(evt.player_id);
						if (evt.secondary_player_id) awayLineup.add(evt.secondary_player_id);
					}
				} else {
					if (isHomePlayer) {
						if (homeLineup.size < 5) homeLineup.add(evt.player_id);
					} else {
						if (awayLineup.size < 5) awayLineup.add(evt.player_id);
					}
				}
			}
		}
	}

	return stints;
}

/**
 * @description Main transformer for NBL FIBA LiveStats play-by-play raw JSON data.
 * @param {string} gameId
 * @param {Object} rawJson
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformNblPbp(gameId, rawJson) {
	if (!rawJson) {
		return { events: [], stints: [] };
	}

	let rawEvents = [];
	if (Array.isArray(rawJson.pbp)) {
		rawEvents = rawJson.pbp;
	} else if (Array.isArray(rawJson.actions)) {
		rawEvents = rawJson.actions;
	} else if (Array.isArray(rawJson.plays)) {
		rawEvents = rawJson.plays;
	} else if (rawJson.game && (Array.isArray(rawJson.game.actions) || Array.isArray(rawJson.game.plays))) {
		rawEvents = rawJson.game.actions || rawJson.game.plays;
	} else if (Array.isArray(rawJson)) {
		rawEvents = rawJson;
	}

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < rawEvents.length; i++) {
		const action = rawEvents[i];

		const period = parseInt(action.period || action.quarter || 1, 10);
		const clockRaw = action.gt ?? action.clock ?? action.time ?? "10:00";
		const secondsRemaining = parseFibaClockToSeconds(clockRaw, period);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.s1 !== undefined && action.s1 !== null) runningHomeScore = parseInt(action.s1, 10);
		else if (action.scoreHome !== undefined) runningHomeScore = parseInt(action.scoreHome, 10);
		else if (action.homeScore !== undefined) runningHomeScore = parseInt(action.homeScore, 10);

		if (action.s2 !== undefined && action.s2 !== null) runningAwayScore = parseInt(action.s2, 10);
		else if (action.scoreAway !== undefined) runningAwayScore = parseInt(action.scoreAway, 10);
		else if (action.awayScore !== undefined) runningAwayScore = parseInt(action.awayScore, 10);

		const isScoring = action.scoring === 1 || action.success === 1 || action.isFieldGoal === 1 || action.isScoringPlay === 1;

		const teamId = action.tno ? String(action.tno) : (action.teamId ? String(action.teamId) : null);
		const playerId = action.personId ? String(action.personId) : (action.playerId ? String(action.playerId) : null);
		const secondaryPlayerId = action.subPersonId || action.secondaryPlayerId || action.assistPersonId || null;

		const actionNum = action.actionNumber ?? action.actionId ?? action.eventNum ?? (i + 1);

		events.push({
			event_id: `${gameId}_pbp_${actionNum}_${i}`,
			game_id: String(gameId),
			period,
			clock: String(clockRaw),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: String(action.actionType || action.eventType || ''),
			sub_type: action.subType ? String(action.subType) : null,
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: secondaryPlayerId ? String(secondaryPlayerId) : null,
			description: action.text || action.description || '',
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: (action.x !== undefined && action.x !== null) ? Number(action.x) : null,
			loc_y: (action.y !== undefined && action.y !== null) ? Number(action.y) : null,
			shot_distance: (action.distance !== undefined && action.distance !== null) ? Number(action.distance) : null,
			is_scoring_play: isScoring ? 1 : 0
		});
	}

	const stints = buildStintsFromEvents(gameId, events);

	return { events, stints };
}
