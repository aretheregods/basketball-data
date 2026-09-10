/**
 * @file BblPbpTransformer.mjs
 * @description Transformer for German Basketball Bundesliga (BBL) Play-by-Play streams.
 * Parses FIBA regulation and overtime clocks, normalizes BBL action types and German play descriptions
 * into standard event codes, tracks substitution state machines to generate 5-on-5 stint intervals.
 */

/**
 * @description Calculates remaining seconds in total game (FIBA regulation = 2400s total, OT = 300s total per period).
 * @param {number} period - Period number (1-4 regulation, 5+ overtime)
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
 * @description Parses BBL clock string into remaining period seconds (0-600s).
 * Handles formats like "00:09:45", "09:45", "10:00", or numeric inputs.
 * @param {string|number} [clockStr] - Clock value
 * @returns {number} Seconds remaining in period
 */
export function parseBblClock(clockStr) {
	if (!clockStr) return 0;
	if (typeof clockStr === 'number') return clockStr;

	const str = String(clockStr).trim();
	const parts = str.split(':');

	if (parts.length === 3) { // e.g. "00:09:45"
		const mins = parseInt(parts[1], 10);
		const secs = parseFloat(parts[2]);
		if (!isNaN(mins) && !isNaN(secs)) {
			return (mins * 60) + secs;
		}
	} else if (parts.length === 2) { // e.g. "09:45"
		const mins = parseInt(parts[0], 10);
		const secs = parseFloat(parts[1]);
		if (!isNaN(mins) && !isNaN(secs)) {
			return (mins * 60) + secs;
		}
	}

	const numeric = parseFloat(str);
	return isNaN(numeric) ? 0 : numeric;
}

/**
 * @description Normalizes German BBL action type codes, qualifiers, and German text to standard event codes.
 * @param {string} typeCode - BBL action type code (e.g., "THREE_POINT_THROW", "REBOUND", "SUBSTITUTION")
 * @param {boolean} [isSuccessful=false] - Scoring/shot success flag
 * @param {string[]} [qualifiers=[]] - Action qualifiers (e.g., ["OFFENSIVE", "DEFENSIVE"])
 * @param {string} [germanText=''] - Optional German description text fallback
 * @returns {string} Normalized event code
 */
export function normalizeBblAction(typeCode, isSuccessful = false, qualifiers = [], germanText = '') {
	const code = String(typeCode || '').toUpperCase().trim();
	const text = String(germanText || '').toLowerCase().trim();
	const qualUpper = (qualifiers || []).map(q => String(q).toUpperCase());

	if (code === 'THREE_POINT_THROW' || code === '3PT') {
		return isSuccessful ? '3FGM' : '3FGA';
	}
	if (code === 'TWO_POINT_THROW' || code === '2PT') {
		return isSuccessful ? '2FGM' : '2FGA';
	}
	if (code === 'FREE_THROW' || code === 'FT') {
		return isSuccessful ? 'FTM' : 'FTA';
	}
	if (code === 'REBOUND' || code === 'TEAM_REBOUND') {
		if (qualUpper.includes('OFFENSIVE') || text.includes('offensiv')) return 'ORB';
		if (qualUpper.includes('DEFENSIVE') || text.includes('defensiv')) return 'DRB';
		return 'DRB';
	}
	if (code === 'TURN_OVER' || code === 'TEAM_TURN_OVER' || code === 'TURNOVER') {
		return 'TOV';
	}
	if (code === 'STEAL') return 'STL';
	if (code === 'FOUL') return 'FOUL';
	if (code === 'BLOCK') return 'BLK';
	if (code === 'SUBSTITUTION' || code === 'SUB') return 'SUB';

	// German Text Fallbacks
	if ((text.includes('3-punkte') || text.includes('dreier')) && (text.includes('erfolgreich') || text.includes('getroffen'))) return '3FGM';
	if ((text.includes('3-punkte') || text.includes('dreier')) && (text.includes('verworfen') || text.includes('nicht erfolgreich'))) return '3FGA';
	if ((text.includes('2-punkte') || text.includes('korbleger') || text.includes('dunking')) && (text.includes('erfolgreich') || text.includes('getroffen'))) return '2FGM';
	if ((text.includes('2-punkte') || text.includes('korbleger') || text.includes('dunking')) && (text.includes('verworfen') || text.includes('nicht erfolgreich'))) return '2FGA';
	if (text.includes('freiwurf') && (text.includes('erfolgreich') || text.includes('getroffen'))) return 'FTM';
	if (text.includes('freiwurf') && (text.includes('verworfen') || text.includes('nicht erfolgreich'))) return 'FTA';
	if (text.includes('offensiv-rebound')) return 'ORB';
	if (text.includes('defensiv-rebound') || text.includes('rebound')) return 'DRB';
	if (text.includes('ballverlust') || text.includes('fehlpass') || text.includes('schrittfehler')) return 'TOV';
	if (text.includes('ballgewinn') || text.includes('steal')) return 'STL';
	if (text.includes('foul')) return 'FOUL';
	if (text.includes('block')) return 'BLK';
	if (text.includes('auswechslung') || text.includes('eingewechselt') || text.includes('ausgewechselt')) return 'SUB';

	return code || 'OTHER';
}

/**
 * @description Lineup State Machine for German BBL PBP events.
 * Groups events by period and constructs 5-on-5 stint intervals.
 * @param {string} gameId
 * @param {string} competitionId
 * @param {Object[]} events
 * @returns {Object[]}
 */
function buildStintsFromEvents(gameId, competitionId, events) {
	const stints = [];

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
			} else if (['ORB', 'OFFENSE_REBOUND'].some(t => typeUpper.includes(t))) {
				stintOreb++;
			} else if (['TOV', 'TO', 'TURNOVER'].some(t => typeUpper.includes(t))) {
				stintTov++;
			}

			const subTypeUpper = String(evt.sub_type || '').toUpperCase();
			const descLower = String(evt.description || '').toLowerCase();
			const isSub = typeUpper === 'SUB' || subTypeUpper === 'IN' || subTypeUpper === 'OUT' ||
				descLower.includes('auswechslung') || descLower.includes('eingewechselt') || descLower.includes('ausgewechselt');

			if (isSub || i === pEvents.length - 1) {
				const durationSecs = Math.max(0, stintStartSecs - evt.seconds_remaining);
				const possEst = Math.max(0, Number((stintFga + (0.44 * stintFta) - stintOreb + stintTov).toFixed(1)));

				const homeArray = Array.from(homeLineup).sort();
				const awayArray = Array.from(awayLineup).sort();

				stints.push({
					stint_id: `${competitionId}_${gameId}_stint_${period}_${stintIndex}`,
					game_id: String(gameId),
					competition_id: competitionId,
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
					const isOut = descLower.includes('ausgewechselt') || subTypeUpper === 'OUT';
					if (isOut) {
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
 * @description Transforms raw German BBL play-by-play payload into standardized event rows and stint intervals.
 * @param {string} gameId - Game identifier
 * @param {Object} rawPayload - Raw BBL play-by-play payload object
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformBblPbp(gameId, rawPayload) {
	if (!rawPayload) return { events: [], stints: [] };

	const cleanGameId = String(gameId || '').trim();
	const seasonYear = rawPayload.seasonYear || '2025';
	const competitionId = rawPayload.competitionId || `BBL${seasonYear}`;

	let rawActions = rawPayload.actions || rawPayload.events || (rawPayload.data && rawPayload.data.pbp) || [];

	if (!Array.isArray(rawActions)) {
		return { events: [], stints: [] };
	}

	// Sort actions chronologically (by orderId / index or period asc + clock desc)
	const actions = rawActions.slice().sort((a, b) => {
		if (a.orderId !== undefined && b.orderId !== undefined) {
			return (a.orderId ?? 0) - (b.orderId ?? 0);
		}
		const pA = parseInt(a.period || 1, 10);
		const pB = parseInt(b.period || 1, 10);
		if (pA !== pB) return pA - pB;

		const clockA = parseBblClock(a.gameTime || a.clock || a.time);
		const clockB = parseBblClock(b.gameTime || b.clock || b.time);
		return clockB - clockA;
	});

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < actions.length; i++) {
		const action = actions[i];

		const period = parseInt(action.period || 1, 10);
		const rawClock = action.gameTime || action.clock || action.time || "10:00";
		let clockStr = String(rawClock);
		if (clockStr.startsWith("00:")) {
			clockStr = clockStr.substring(3);
		}

		const secondsRemaining = parseBblClock(rawClock);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.homeTeamPoints !== undefined && action.homeTeamPoints !== null) {
			runningHomeScore = parseInt(action.homeTeamPoints, 10);
		}
		if (action.guestTeamPoints !== undefined && action.guestTeamPoints !== null) {
			runningAwayScore = parseInt(action.guestTeamPoints, 10);
		} else if (action.awayTeamPoints !== undefined && action.awayTeamPoints !== null) {
			runningAwayScore = parseInt(action.awayTeamPoints, 10);
		}

		const eventType = normalizeBblAction(action.type, action.isSuccessful, action.qualifiers, action.description || action.desc || action.text);
		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType) ? 1 : 0;

		const teamId = action.seasonTeamId ? String(action.seasonTeamId) : (action.teamId ? String(action.teamId) : null);
		const playerId = action.seasonPlayerId ? String(action.seasonPlayerId) : (action.playerId ? String(action.playerId) : null);
		const secondaryPlayerId = action.assistingSeasonPlayerId ? String(action.assistingSeasonPlayerId) : (action.secondaryPlayerId ? String(action.secondaryPlayerId) : null);

		const actionId = action.id || action.actionIdentifier || i;

		events.push({
			event_id: `${competitionId}_${cleanGameId}_bbl_pbp_${actionId}_${i}`,
			game_id: cleanGameId,
			competition_id: competitionId,
			period,
			clock: String(clockStr),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: action.qualifiers && action.qualifiers.length > 0 ? action.qualifiers.join(',') : (action.subType ? String(action.subType) : null),
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: secondaryPlayerId,
			description: String(action.description || action.desc || action.text || action.type || ''),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: action.coordinates?.x ?? action.loc_x ?? action.x ?? null,
			loc_y: action.coordinates?.y ?? action.loc_y ?? action.y ?? null,
			shot_distance: action.shotDistance ?? action.distance ?? null,
			is_scoring_play: isScoring
		});
	}

	const stints = buildStintsFromEvents(cleanGameId, competitionId, events);

	return { events, stints };
}
