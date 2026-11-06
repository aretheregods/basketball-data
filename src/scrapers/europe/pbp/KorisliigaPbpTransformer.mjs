/**
 * @file KorisliigaPbpTransformer.mjs
 * @description Transformer for Finnish Korisliiga Play-by-Play streams.
 * Parses FIBA regulation and overtime clocks, normalizes Finnish/FIBA action descriptions
 * into standard event codes, tracks substitutions to generate 5-on-5 stint intervals.
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
 * @description Parses Korisliiga clock string into remaining period seconds (0-600s).
 * Handles formats like "00:09:50", "09:50", "10:00", or numeric seconds.
 * @param {string|number} [clockStr] - Clock value
 * @returns {number} Seconds remaining in period
 */
export function parseKorisliigaClock(clockStr) {
	if (!clockStr) return 0;
	if (typeof clockStr === 'number') return clockStr;

	const str = String(clockStr).trim();
	const parts = str.split(':');

	if (parts.length === 3) { // e.g. "00:09:50"
		const mins = parseInt(parts[1], 10);
		const secs = parseFloat(parts[2]);
		if (!isNaN(mins) && !isNaN(secs)) {
			return (mins * 60) + secs;
		}
	} else if (parts.length === 2) { // e.g. "09:50"
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
 * @description Normalizes Finnish Korisliiga action types, Finnish descriptions and qualifiers into standard event codes.
 * @param {string} actionType
 * @param {boolean} [isSuccessful=false]
 * @param {string} [subType='']
 * @param {string} [description='']
 * @returns {string} Standard event code (3FGM, 2FGM, FTM, etc.)
 */
export function normalizeKorisliigaAction(actionType = '', isSuccessful = false, subType = '', description = '') {
	const typeUpper = String(actionType || '').toUpperCase().trim();
	const subUpper = String(subType || '').toUpperCase().trim();
	const descLower = String(description || '').toLowerCase().trim();

	if (typeUpper === '3P' || typeUpper === '3PT' || typeUpper === 'THREE_POINT' || typeUpper === '3PTR') {
		if (isSuccessful || descLower.includes('onnistunut') || descLower.includes('made') || descLower.includes('sisään')) return '3FGM';
		return '3FGA';
	}

	if (typeUpper === '2P' || typeUpper === '2PT' || typeUpper === 'TWO_POINT' || typeUpper === 'LAYUP' || typeUpper === 'DUNK') {
		if (isSuccessful || descLower.includes('onnistunut') || descLower.includes('made') || descLower.includes('sisään')) return '2FGM';
		return '2FGA';
	}

	if (typeUpper === '1P' || typeUpper === 'FT' || typeUpper === 'FREE_THROW' || typeUpper === 'VAPARI') {
		if (isSuccessful || descLower.includes('onnistunut') || descLower.includes('made') || descLower.includes('sisään')) return 'FTM';
		return 'FTA';
	}

	if (typeUpper === 'LEVYPALLO' || typeUpper === 'REBOUND' || typeUpper === 'REB') {
		if (subUpper.includes('HYÖKK') || subUpper.includes('OFF') || descLower.includes('hyökkäyslevypallo') || descLower.includes('offensive')) return 'ORB';
		if (subUpper.includes('PUOL') || subUpper.includes('DEF') || descLower.includes('puolustuslevypallo') || descLower.includes('defensive')) return 'DRB';
		return 'DRB';
	}

	if (typeUpper === 'MENETYS' || typeUpper === 'TURNOVER' || typeUpper === 'TOV') {
		return 'TOV';
	}

	if (typeUpper === 'RIISTO' || typeUpper === 'STEAL' || typeUpper === 'STL') {
		return 'STL';
	}

	if (typeUpper === 'VIRHE' || typeUpper === 'FOUL' || typeUpper === 'PF') {
		return 'FOUL';
	}

	if (typeUpper === 'TORJUNTA' || typeUpper === 'BLOCK' || typeUpper === 'BLK') {
		return 'BLK';
	}

	if (typeUpper === 'VAIHTO' || typeUpper === 'SUBSTITUTION' || typeUpper === 'SUB') {
		return 'SUB';
	}

	// Description matching
	if (descLower.includes('3p') || descLower.includes('kolmonen') || descLower.includes('kolmen pisteen')) {
		return (descLower.includes('onnistunut') || descLower.includes('made') || descLower.includes('sisään')) ? '3FGM' : '3FGA';
	}
	if (descLower.includes('2p') || descLower.includes('kakkonen') || descLower.includes('kahden pisteen') || descLower.includes('kuppi') || descLower.includes('donkki')) {
		return (descLower.includes('onnistunut') || descLower.includes('made') || descLower.includes('sisään')) ? '2FGM' : '2FGA';
	}
	if (descLower.includes('vapaaheitto') || descLower.includes('vapari')) {
		return (descLower.includes('onnistunut') || descLower.includes('made') || descLower.includes('sisään')) ? 'FTM' : 'FTA';
	}
	if (descLower.includes('hyökkäyslevypallo')) return 'ORB';
	if (descLower.includes('puolustuslevypallo') || descLower.includes('levypallo')) return 'DRB';
	if (descLower.includes('menetys') || descLower.includes('askeleet')) return 'TOV';
	if (descLower.includes('riisto')) return 'STL';
	if (descLower.includes('virhe')) return 'FOUL';
	if (descLower.includes('torjunta') || descLower.includes('blokki')) return 'BLK';
	if (descLower.includes('vaihto') || descLower.includes('sisään') || descLower.includes('pois')) return 'SUB';

	return typeUpper || 'OTHER';
}

/**
 * @description Lineup State Machine for Finnish Korisliiga PBP events.
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
				descLower.includes('vaihto') || descLower.includes('sisään') || descLower.includes('pois');

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
					const isOut = descLower.includes('pois') || subTypeUpper === 'OUT';
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
 * @description Transforms raw Finnish Korisliiga play-by-play payload into standardized event rows and stint intervals.
 * @param {string} gameId - Game identifier
 * @param {Object} rawPayload - Raw Korisliiga play-by-play payload object
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformKorisliigaPbp(gameId, rawPayload) {
	if (!rawPayload) return { events: [], stints: [] };

	const cleanGameId = String(gameId || '').trim();
	const seasonYear = rawPayload.seasonYear || '2024';
	const competitionId = rawPayload.competitionId || `KORISLIIGA${seasonYear}`;

	let rawActions = [];

	if (rawPayload.source === 'fiba_livestats' || (rawPayload.data && rawPayload.data.pbp) || (rawPayload.pbp && Array.isArray(rawPayload.pbp))) {
		rawActions = rawPayload.data?.pbp || rawPayload.pbp || [];
	} else if (Array.isArray(rawPayload.actions)) {
		rawActions = rawPayload.actions;
	} else if (Array.isArray(rawPayload.events)) {
		rawActions = rawPayload.events;
	}

	if (!Array.isArray(rawActions)) {
		return { events: [], stints: [] };
	}

	// Sort actions chronologically
	const actions = rawActions.slice().sort((a, b) => {
		if (a.actionNumber !== undefined && b.actionNumber !== undefined) {
			return (a.actionNumber ?? 0) - (b.actionNumber ?? 0);
		}
		if (a.id !== undefined && b.id !== undefined && typeof a.id === 'number' && typeof b.id === 'number') {
			return a.id - b.id;
		}
		const pA = parseInt(a.period || 1, 10);
		const pB = parseInt(b.period || 1, 10);
		if (pA !== pB) return pA - pB;

		const clockA = parseKorisliigaClock(a.gameTime || a.clock || a.gt || a.time);
		const clockB = parseKorisliigaClock(b.gameTime || b.clock || b.gt || b.time);
		return clockB - clockA;
	});

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < actions.length; i++) {
		const action = actions[i];

		const period = parseInt(action.period || 1, 10);
		const rawClock = action.gameTime || action.clock || action.gt || action.time || "10:00";
		let clockStr = String(rawClock);
		if (clockStr.startsWith("00:")) {
			clockStr = clockStr.substring(3);
		}

		const secondsRemaining = parseKorisliigaClock(rawClock);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.s1 !== undefined && action.s1 !== null) {
			runningHomeScore = parseInt(action.s1, 10);
		} else if (action.homeScore !== undefined && action.homeScore !== null) {
			runningHomeScore = parseInt(action.homeScore, 10);
		} else if (action.homeTeamPoints !== undefined && action.homeTeamPoints !== null) {
			runningHomeScore = parseInt(action.homeTeamPoints, 10);
		}

		if (action.s2 !== undefined && action.s2 !== null) {
			runningAwayScore = parseInt(action.s2, 10);
		} else if (action.awayScore !== undefined && action.awayScore !== null) {
			runningAwayScore = parseInt(action.awayScore, 10);
		} else if (action.guestTeamPoints !== undefined && action.guestTeamPoints !== null) {
			runningAwayScore = parseInt(action.guestTeamPoints, 10);
		}

		const actionType = action.actionType || action.type || '';
		const isSuccess = action.success === 1 || action.isSuccessful === true || action.success === true;
		const subType = action.subType || (action.qualifiers ? action.qualifiers.join(',') : '');
		const desc = action.description || action.desc || action.text || '';

		const eventType = normalizeKorisliigaAction(actionType, isSuccess, subType, desc);
		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType) ? 1 : 0;

		const teamId = action.teamId ? String(action.teamId) : (action.tno ? String(action.tno) : null);
		const playerId = action.playerId ? String(action.playerId) : (action.player ? String(action.player) : (action.personId ? String(action.personId) : null));
		const secondaryPlayerId = action.secondaryPlayerId ? String(action.secondaryPlayerId) : (action.assistPlayer ? String(action.assistPlayer) : null);

		const actionId = action.actionNumber || action.id || i;

		events.push({
			event_id: `${competitionId}_${cleanGameId}_korisliiga_pbp_${actionId}_${i}`,
			game_id: cleanGameId,
			competition_id: competitionId,
			period,
			clock: String(clockStr),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: subType || null,
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: secondaryPlayerId,
			description: String(desc || actionType || ''),
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
