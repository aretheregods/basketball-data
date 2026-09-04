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
export function parseAcbClock(clockStr) {
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
 * @description Normalizes Spanish ACB event texts and action codes into standard normalized event codes.
 * @param {string} spanishText - Raw description text from ACB payload
 * @param {string} typeCode - Raw event/action type code
 * @returns {string} Normalized event type code
 */
export function normalizeAcbAction(spanishText = '', typeCode = '') {
	const text = String(spanishText || '').toLowerCase();
	const type = String(typeCode || '').toUpperCase();

	if (type === '3FGM' || text.includes('triple anotado') || text.includes('canasta de 3') || text.includes('3pt made')) {
		return '3FGM';
	}
	if (type === '3FGA' || text.includes('triple fallado') || text.includes('intento de 3') || text.includes('3pt miss')) {
		return '3FGA';
	}
	if (type === '2FGM' || text.includes('canasta de 2') || text.includes('mate') || text.includes('palmeo') || text.includes('bandeja') || text.includes('2pt made')) {
		return '2FGM';
	}
	if (type === '2FGA' || text.includes('tiro de 2 fallado') || text.includes('intento de 2') || text.includes('2pt miss')) {
		return '2FGA';
	}
	if (type === 'FTM' || text.includes('tiro libre anotado') || text.includes('tl anotado') || text.includes('ft made')) {
		return 'FTM';
	}
	if (type === 'FTA' || text.includes('tiro libre fallado') || text.includes('tl fallado') || text.includes('ft miss')) {
		return 'FTA';
	}
	if (type === 'ORB' || text.includes('rebote ofensivo') || text.includes('offensive rebound')) {
		return 'ORB';
	}
	if (type === 'DRB' || text.includes('rebote defensivo') || text.includes('defensive rebound') || text.includes('rebote')) {
		return 'DRB';
	}
	if (type === 'TOV' || text.includes('pérdida') || text.includes('campo atrás') || text.includes('turnover') || text.includes('pasos')) {
		return 'TOV';
	}
	if (type === 'BLK' || text.includes('tapón') || text.includes('tapon') || text.includes('block')) {
		return 'BLK';
	}
	if (type === 'FOUL' || text.includes('falta') || text.includes('foul')) {
		return 'FOUL';
	}
	if (type === 'SUB' || text.includes('cambio') || text.includes('entra') || text.includes('sale') || text.includes('substitucion')) {
		return 'SUB';
	}

	return type || 'OTHER';
}

/**
 * @description Lineup State Machine for Spanish ACB PBP events.
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
			const isSub = typeUpper === 'SUB' || subTypeUpper === 'IN' || subTypeUpper === 'OUT' || descLower.includes('entra') || descLower.includes('sale') || descLower.includes('cambio');

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
					const isOut = descLower.includes('sale') || subTypeUpper === 'OUT';
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
 * @description Main transformation function for Spanish ACB raw PBP JSON payloads.
 * @param {string} gameId
 * @param {Object} rawJson
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformAcbPbp(gameId, rawJson) {
	if (!rawJson) return { events: [], stints: [] };

	const seasonYear = rawJson.seasonYear || '2025';
	const competitionId = rawJson.competitionId || `ACB${seasonYear}`;

	let rawEvents = [];
	if (Array.isArray(rawJson.jugadas)) {
		rawEvents = rawJson.jugadas;
	} else if (Array.isArray(rawJson.rows)) {
		rawEvents = rawJson.rows;
	} else if (Array.isArray(rawJson.plays)) {
		rawEvents = rawJson.plays;
	} else if (Array.isArray(rawJson.actions)) {
		rawEvents = rawJson.actions;
	} else if (Array.isArray(rawJson)) {
		rawEvents = rawJson;
	}

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < rawEvents.length; i++) {
		const action = rawEvents[i];

		const period = parseInt(action.periodo || action.period || action.quarter || 1, 10);
		const clockRaw = action.tiempo || action.clock || action.reloj || "10:00";
		const secondsRemaining = parseAcbClock(clockRaw);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.puntosLocal !== undefined && action.puntosLocal !== null) runningHomeScore = parseInt(action.puntosLocal, 10);
		else if (action.home_score !== undefined && action.home_score !== null) runningHomeScore = parseInt(action.home_score, 10);

		if (action.puntosVisitante !== undefined && action.puntosVisitante !== null) runningAwayScore = parseInt(action.puntosVisitante, 10);
		else if (action.away_score !== undefined && action.away_score !== null) runningAwayScore = parseInt(action.away_score, 10);

		const spanishText = action.texto || action.descripcion || action.description || '';
		const rawType = action.tipo || action.event_type || action.type || '';
		const eventType = normalizeAcbAction(spanishText, rawType);

		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType) || Number(action.puntos || action.points || 0) > 0;
		const actionId = action.id ?? action.action_id ?? action.playNumber ?? (i + 1);

		events.push({
			event_id: `${competitionId}_${gameId}_acb_pbp_${actionId}_${i}`,
			game_id: String(gameId),
			competition_id: competitionId,
			period,
			clock: String(clockRaw),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: action.subtipo !== undefined && action.subtipo !== null ? String(action.subtipo) : null,
			team_id: action.idEquipo ? String(action.idEquipo) : (action.team_id ? String(action.team_id) : null),
			player_id: action.idJugador ? String(action.idJugador) : (action.player_id ? String(action.player_id) : null),
			secondary_player_id: action.idJugadorSecundario ? String(action.idJugadorSecundario) : (action.secondary_player_id ? String(action.secondary_player_id) : null),
			description: String(spanishText),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: action.posX !== undefined && action.posX !== null ? Number(action.posX) : (action.loc_x ?? null),
			loc_y: action.posY !== undefined && action.posY !== null ? Number(action.posY) : (action.loc_y ?? null),
			shot_distance: action.distancia !== undefined && action.distancia !== null ? Number(action.distancia) : (action.shot_distance ?? null),
			is_scoring_play: isScoring ? 1 : 0
		});
	}

	const stints = buildStintsFromEvents(gameId, competitionId, events);

	return { events, stints };
}
