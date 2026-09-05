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
 * @description Parses clock strings (e.g. "09:45" or "9:45") into remaining period seconds.
 * @param {string} clockStr - Display clock string
 * @returns {number}
 */
export function parseLnbClock(clockStr) {
	if (!clockStr || typeof clockStr !== 'string') return 0;
	const parts = clockStr.split(':');
	if (parts.length === 2) {
		const mins = parseInt(parts[0], 10);
		const secs = parseFloat(parts[1]);
		if (!isNaN(mins) && !isNaN(secs)) {
			return (mins * 60) + secs;
		}
	}
	return 0;
}

/**
 * @description Normalizes French LNB event texts and action codes into standard normalized event codes.
 * @param {string} frenchText - Raw description text from LNB payload
 * @param {string} typeCode - Raw event/action type code
 * @returns {string} Normalized event type code
 */
export function normalizeLnbAction(frenchText = '', typeCode = '') {
	const text = String(frenchText || '').toLowerCase();
	const type = String(typeCode || '').toUpperCase();

	if (type === '3FGM' || text.includes('3pts réussi') || text.includes('3pt réussi') || text.includes('tir à 3pts réussi') || text.includes('3pt made')) {
		return '3FGM';
	}
	if (type === '3FGA' || text.includes('3pts manqué') || text.includes('3pt manqué') || text.includes('tir à 3pts manqué') || text.includes('3pt miss')) {
		return '3FGA';
	}
	if (type === '2FGM' || text.includes('2pts réussi') || text.includes('2pt réussi') || text.includes('dunk') || text.includes('layup') || text.includes('panier') || text.includes('2pt made')) {
		return '2FGM';
	}
	if (type === '2FGA' || text.includes('2pts manqué') || text.includes('2pt manqué') || text.includes('tir à 2pts manqué') || text.includes('2pt miss')) {
		return '2FGA';
	}
	if (type === 'FTM' || text.includes('lancer franc réussi') || text.includes('lf réussi') || text.includes('ft made')) {
		return 'FTM';
	}
	if (type === 'FTA' || text.includes('lancer franc manqué') || text.includes('lf manqué') || text.includes('ft miss')) {
		return 'FTA';
	}
	if (type === 'ORB' || text.includes('rebond offensif') || text.includes('offensive rebound')) {
		return 'ORB';
	}
	if (type === 'DRB' || text.includes('rebond défensif') || text.includes('rebond defensif') || text.includes('defensive rebound') || text.includes('rebond')) {
		return 'DRB';
	}
	if (type === 'TOV' || text.includes('balle perdue') || text.includes('perte de balle') || text.includes('turnover')) {
		return 'TOV';
	}
	if (type === 'BLK' || text.includes('contre') || text.includes('tir contré') || text.includes('block')) {
		return 'BLK';
	}
	if (type === 'FOUL' || text.includes('faute') || text.includes('faute personnelle') || text.includes('foul')) {
		return 'FOUL';
	}
	if (type === 'SUB' || text.includes('changement') || text.includes('entre') || text.includes('sort') || text.includes('remplacement')) {
		return 'SUB';
	}

	return type || 'OTHER';
}

/**
 * @description Lineup State Machine for French LNB PBP events.
 * Partitions period events into 5-on-5 stint intervals.
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
			const isSub = typeUpper === 'SUB' || subTypeUpper === 'IN' || subTypeUpper === 'OUT' || descLower.includes('entre') || descLower.includes('sort') || descLower.includes('changement');

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
					const isOut = descLower.includes('sort') || subTypeUpper === 'OUT';
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
 * @description Main transformation function for French LNB raw PBP JSON payloads.
 * @param {string} gameId
 * @param {Object} rawJson
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformLnbPbp(gameId, rawJson) {
	if (!rawJson) return { events: [], stints: [] };

	const seasonYear = rawJson.seasonYear || '2025';
	const competitionId = rawJson.competitionId || `LNB${seasonYear}`;

	let rawEvents = [];
	if (Array.isArray(rawJson.actions)) {
		rawEvents = rawJson.actions;
	} else if (Array.isArray(rawJson.rows)) {
		rawEvents = rawJson.rows;
	} else if (Array.isArray(rawJson.plays)) {
		rawEvents = rawJson.plays;
	} else if (Array.isArray(rawJson.jugadas)) {
		rawEvents = rawJson.jugadas;
	} else if (Array.isArray(rawJson)) {
		rawEvents = rawJson;
	}

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < rawEvents.length; i++) {
		const action = rawEvents[i];

		const period = parseInt(action.periode || action.period || action.quarter || 1, 10);
		const clockRaw = action.chrono || action.clock || action.reloj || "10:00";
		const secondsRemaining = parseLnbClock(clockRaw);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.scoreDomicile !== undefined && action.scoreDomicile !== null) runningHomeScore = parseInt(action.scoreDomicile, 10);
		else if (action.home_score !== undefined && action.home_score !== null) runningHomeScore = parseInt(action.home_score, 10);

		if (action.scoreExterieur !== undefined && action.scoreExterieur !== null) runningAwayScore = parseInt(action.scoreExterieur, 10);
		else if (action.away_score !== undefined && action.away_score !== null) runningAwayScore = parseInt(action.away_score, 10);

		const frenchText = action.libelle || action.description || action.texto || '';
		const rawType = action.type || action.event_type || action.tipo || '';
		const eventType = normalizeLnbAction(frenchText, rawType);

		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType) || Number(action.puntos || action.points || 0) > 0;
		const actionId = action.id ?? action.action_id ?? action.playNumber ?? (i + 1);

		events.push({
			event_id: `${competitionId}_${gameId}_lnb_pbp_${actionId}_${i}`,
			game_id: String(gameId),
			competition_id: competitionId,
			period,
			clock: String(clockRaw),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: action.sousType !== undefined && action.sousType !== null ? String(action.sousType) : (action.subtipo !== undefined && action.subtipo !== null ? String(action.subtipo) : null),
			team_id: action.equipeId ? String(action.equipeId) : (action.team_id ? String(action.team_id) : (action.idEquipo ? String(action.idEquipo) : null)),
			player_id: action.joueurId ? String(action.joueurId) : (action.player_id ? String(action.player_id) : (action.idJugador ? String(action.idJugador) : null)),
			secondary_player_id: action.joueurSecondaireId ? String(action.joueurSecondaireId) : (action.secondary_player_id ? String(action.secondary_player_id) : null),
			description: String(frenchText),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: action.coordX !== undefined && action.coordX !== null ? Number(action.coordX) : (action.posX !== undefined && action.posX !== null ? Number(action.posX) : (action.loc_x ?? null)),
			loc_y: action.coordY !== undefined && action.coordY !== null ? Number(action.coordY) : (action.posY !== undefined && action.posY !== null ? Number(action.posY) : (action.loc_y ?? null)),
			shot_distance: action.distance !== undefined && action.distance !== null ? Number(action.distance) : (action.shot_distance ?? null),
			is_scoring_play: isScoring ? 1 : 0
		});
	}

	const stints = buildStintsFromEvents(gameId, competitionId, events);

	return { events, stints };
}
