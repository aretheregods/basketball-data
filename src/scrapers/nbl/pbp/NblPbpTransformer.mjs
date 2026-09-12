/**
 * @description Clock converter utility for FIBA / NBL LiveStats.
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
 * @description Normalizes raw action text / type into standard event codes.
 * @param {string} textRaw
 * @param {string} actionType
 * @returns {string}
 */
export function normalizeNblAction(textRaw, actionType) {
	const text = String(textRaw || '').toLowerCase();
	const type = String(actionType || '').toLowerCase();

	if (type.includes('3pt') || type === '3fgm' || (text.includes('3pt') && (text.includes('made') || text.includes('make')))) return '3FGM';
	if (type.includes('3fga') || (text.includes('3pt') && text.includes('miss'))) return '3FGA';
	if (type.includes('2pt') || type === '2fgm' || text.includes('dunk') || ((text.includes('2pt') || text.includes('layup') || text.includes('jump shot') || text.includes('shot')) && (text.includes('made') || text.includes('make')))) return '2FGM';
	if (type.includes('2fga') || ((text.includes('2pt') || text.includes('layup') || text.includes('jump shot') || text.includes('shot')) && text.includes('miss'))) return '2FGA';
	if (type.includes('ftm') || (text.includes('free throw') && (text.includes('made') || text.includes('make')))) return 'FTM';
	if (type.includes('fta') || (text.includes('free throw') && text.includes('miss'))) return 'FTA';
	if (type.includes('orb') || text.includes('offensive rebound')) return 'ORB';
	if (type.includes('drb') || text.includes('defensive rebound') || text.includes('rebound')) return 'DRB';
	if (type.includes('tov') || text.includes('turnover') || text.includes('bad pass') || text.includes('out of bounds')) return 'TOV';
	if (type.includes('stl') || text.includes('steal')) return 'STL';
	if (type.includes('foul') || text.includes('foul')) return 'FOUL';
	if (type.includes('blk') || text.includes('block')) return 'BLK';
	if (type.includes('sub') || text.includes('substitution') || text.includes('sub in') || text.includes('sub out')) return 'SUB';

	return actionType || 'OTHER';
}

/**
 * @description State Machine to group events by period and track substitutions into 5-on-5 stint intervals.
 * @param {string} gameId
 * @param {Object[]} events
 * @returns {Object[]}
 */
function buildStintsFromEvents(gameId, events, competitionId = null) {
	const stints = [];
	const periodMap = new Map();

	// Determine unique team IDs from events
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
			const isFieldGoal = typeStr.includes('shot') || typeStr === '1' || typeStr === '2' || typeStr.includes('field goal') || typeStr.includes('fg');
			const isFreeThrow = typeStr.includes('free') || typeStr.includes('ft') || typeStr === '3';
			const isRebound = typeStr.includes('rebound') || typeStr === '4' || typeStr.includes('rb');
			const isTurnover = typeStr.includes('turnover') || typeStr === '5' || typeStr.includes('tov');
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
					competition_id: competitionId ? String(competitionId) : null,
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
 * @description Main transformer for NBL play-by-play raw JSON data.
 * Supports payloads from Tier 1 API, Tier 2 Webflow embedded state / DOM, and Tier 3 FIBA LiveStats.
 * @param {string} gameId
 * @param {Object} rawJson
 * @param {string} [competitionId=null]
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformNblPbp(gameId, rawJson, competitionId = null) {
	if (!rawJson) {
		return { events: [], stints: [] };
	}

	// Unwrap wrapper objects if nested in { source, data }
	const dataPayload = rawJson.data ? rawJson.data : rawJson;

	let rawEvents = [];
	if (Array.isArray(dataPayload.pbp)) {
		rawEvents = dataPayload.pbp;
	} else if (Array.isArray(dataPayload.actions)) {
		rawEvents = dataPayload.actions;
	} else if (Array.isArray(dataPayload.plays)) {
		rawEvents = dataPayload.plays;
	} else if (Array.isArray(dataPayload.events)) {
		rawEvents = dataPayload.events;
	} else if (dataPayload.game && (Array.isArray(dataPayload.game.actions) || Array.isArray(dataPayload.game.plays) || Array.isArray(dataPayload.game.pbp))) {
		rawEvents = dataPayload.game.actions || dataPayload.game.plays || dataPayload.game.pbp;
	} else if (Array.isArray(dataPayload)) {
		rawEvents = dataPayload;
	}

	const compId = competitionId || (rawJson && (rawJson.competitionId || rawJson.competition_id)) || null;
	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < rawEvents.length; i++) {
		const action = rawEvents[i];

		const period = parseInt(action.period || action.quarter || 1, 10);
		const clockRaw = action.gt ?? action.clock ?? action.time ?? "10:00";
		const secondsRemaining = parseFibaClockToSeconds(clockRaw, period);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		// Handle score extraction across FIBA (s1/s2), NBL API (scoreHome/scoreAway), and Webflow/DOM (score string "10 - 8")
		if (action.s1 !== undefined && action.s1 !== null) runningHomeScore = parseInt(action.s1, 10);
		else if (action.scoreHome !== undefined) runningHomeScore = parseInt(action.scoreHome, 10);
		else if (action.homeScore !== undefined) runningHomeScore = parseInt(action.homeScore, 10);

		if (action.s2 !== undefined && action.s2 !== null) runningAwayScore = parseInt(action.s2, 10);
		else if (action.scoreAway !== undefined) runningAwayScore = parseInt(action.scoreAway, 10);
		else if (action.awayScore !== undefined) runningAwayScore = parseInt(action.awayScore, 10);

		if ((action.scoreHome === undefined && action.s1 === undefined) && typeof action.score === 'string' && action.score.includes('-')) {
			const parts = action.score.split('-').map(s => parseInt(s.trim(), 10));
			if (!isNaN(parts[0])) runningHomeScore = parts[0];
			if (!isNaN(parts[1])) runningAwayScore = parts[1];
		}

		const eventTypeRaw = action.actionType || action.type || action.eventType || action.desc || action.description || '';
		const normalizedType = normalizeNblAction(action.text || action.desc || action.description, eventTypeRaw);
		const isScoring = action.scoring === 1 || action.success === 1 || action.isFieldGoal === 1 || action.isScoringPlay === 1 || ['2FGM', '3FGM', 'FTM'].includes(normalizedType);

		const teamId = action.tno ? String(action.tno) : (action.teamId ? String(action.teamId) : (action.team ? String(action.team) : null));
		const playerId = action.personId ? String(action.personId) : (action.playerId ? String(action.playerId) : null);
		const secondaryPlayerId = action.subPersonId || action.secondaryPlayerId || action.assistPersonId || null;

		const actionNum = action.actionNumber ?? action.actionId ?? action.eventNum ?? (i + 1);

		events.push({
			event_id: `${gameId}_pbp_${actionNum}_${i}`,
			game_id: String(gameId),
			competition_id: compId ? String(compId) : null,
			period,
			clock: String(clockRaw),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: normalizedType,
			sub_type: action.subType ? String(action.subType) : null,
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: secondaryPlayerId ? String(secondaryPlayerId) : null,
			description: action.text || action.description || action.desc || '',
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: (action.x !== undefined && action.x !== null) ? Number(action.x) : null,
			loc_y: (action.y !== undefined && action.y !== null) ? Number(action.y) : null,
			shot_distance: (action.distance !== undefined && action.distance !== null) ? Number(action.distance) : null,
			is_scoring_play: isScoring ? 1 : 0
		});
	}

	const stints = buildStintsFromEvents(gameId, events, compId);

	return { events, stints };
}
