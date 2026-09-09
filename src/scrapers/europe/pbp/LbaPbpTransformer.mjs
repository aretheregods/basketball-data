/**
 * @file LbaPbpTransformer.mjs
 * @description Transformer for Italian Lega Basket Serie A (LBA) Play-by-Play streams.
 * Parses FIBA regulation and overtime clocks, normalizes Italian play descriptions to standard event codes,
 * tracks on-court team lineups, and generates 5-on-5 stint intervals.
 */

/**
 * @description Calculates remaining seconds in total game (regulation = 2400s total, OT = 300s total per period).
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
 * @description Parses clock string or minute/second attributes into period seconds remaining (0-600s).
 * @param {string} [clockStr] - Clock string (e.g. "09:45")
 * @param {number} [minute] - Minute remaining
 * @param {number} [seconds] - Seconds remaining
 * @returns {number}
 */
export function parseLbaClock(clockStr, minute, seconds) {
	if (clockStr && typeof clockStr === 'string' && clockStr.includes(':')) {
		const parts = clockStr.split(':');
		if (parts.length === 2) {
			const mins = parseInt(parts[0], 10);
			const secs = parseFloat(parts[1]);
			if (!isNaN(mins) && !isNaN(secs)) {
				return (mins * 60) + secs;
			}
		}
	}
	if (minute !== undefined && seconds !== undefined) {
		return ((parseInt(minute, 10) || 0) * 60) + (parseFloat(seconds) || 0);
	}
	return 0;
}

/**
 * @description Normalizes Italian LBA action descriptions and codes to standard event types.
 * @param {string} italianText - Action description text
 * @param {string|number} [typeCode] - Optional fallback action type code
 * @returns {string} Normalized event type
 */
export function normalizeLbaAction(italianText, typeCode) {
	const text = String(italianText || '').toLowerCase();
	const code = String(typeCode || '').toUpperCase();

	if (code === '3FGM' || (text.includes('3 punti') && (text.includes('segnato') || text.includes('realizzato') || text.includes('canestro')))) return '3FGM';
	if (code === '3FGA' || (text.includes('3 punti') && (text.includes('sbagliato') || text.includes('errato')))) return '3FGA';
	if (code === '2FGM' || (text.includes('2 punti') && (text.includes('segnato') || text.includes('realizzato') || text.includes('canestro'))) || text.includes('schiacciata')) return '2FGM';
	if (code === '2FGA' || (text.includes('2 punti') && (text.includes('sbagliato') || text.includes('errato')))) return '2FGA';
	if (code === 'FTM' || (text.includes('libero') && (text.includes('segnato') || text.includes('realizzato')))) return 'FTM';
	if (code === 'FTA' || (text.includes('libero') && (text.includes('sbagliato') || text.includes('errato')))) return 'FTA';
	if (code === 'ORB' || text.includes('rimbalzo offensivo')) return 'ORB';
	if (code === 'DRB' || text.includes('rimbalzo difensivo') || text.includes('rimbalzo')) return 'DRB';
	if (code === 'TOV' || text.includes('palla persa') || text.includes('persa')) return 'TOV';
	if (code === 'STL' || text.includes('palla rubata') || text.includes('rubata')) return 'STL';
	if (code === 'FOUL' || text.includes('fallo')) return 'FOUL';
	if (code === 'BLK' || text.includes('stoppata')) return 'BLK';
	if (code === 'SUB' || text.includes('ingresso') || text.includes('uscita') || text.includes('sostituzione')) return 'SUB';

	return code || 'OTHER';
}

/**
 * @description Lineup State Machine for Italian LBA PBP events.
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
			const isSub = typeUpper === 'SUB' || subTypeUpper === 'IN' || subTypeUpper === 'OUT' || descLower.includes('ingresso') || descLower.includes('uscita') || descLower.includes('sostituzione');

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
					const isOut = descLower.includes('uscita') || subTypeUpper === 'OUT';
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
 * @description Transforms raw Italian LBA play-by-play payload into standardized event rows and stint intervals.
 * @param {string} gameId - Game identifier
 * @param {Object} rawPayload - Raw LBA play-by-play JSON object
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformLbaPbp(gameId, rawPayload) {
	if (!rawPayload) return { events: [], stints: [] };

	const cleanGameId = String(gameId || '').trim();
	const seasonYear = rawPayload.seasonYear || '2025';
	const competitionId = rawPayload.competitionId || `LBA${seasonYear}`;

	const pbpObj = rawPayload.pbp || rawPayload;
	let rawActions = pbpObj.actions || rawPayload.actions || pbpObj.jugadas || [];

	if (!Array.isArray(rawActions)) {
		return { events: [], stints: [] };
	}

	// Make a copy and sort chronologically (ascending by order if present, or period asc / clock desc)
	const actions = rawActions.slice().sort((a, b) => {
		if (a.order !== undefined && b.order !== undefined) {
			return (a.order ?? 0) - (b.order ?? 0);
		}
		const pA = parseInt(a.period || a.periodo || 1, 10);
		const pB = parseInt(b.period || b.periodo || 1, 10);
		if (pA !== pB) return pA - pB;
		const clockA = parseLbaClock(a.print_time || a.clock || a.tiempo, a.minute, a.seconds);
		const clockB = parseLbaClock(b.print_time || b.clock || b.tiempo, b.minute, b.seconds);
		return clockB - clockA;
	});

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < actions.length; i++) {
		const action = actions[i];

		const period = parseInt(action.period || action.periodo || action.quarter || 1, 10);
		const clockStr = action.print_time || action.clock || action.tiempo || "10:00";
		const secondsRemaining = parseLbaClock(clockStr, action.minute, action.seconds);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		// Parse running score "Home - Away" if present in string format "76 - 92"
		if (action.score && typeof action.score === 'string' && action.score.includes('-')) {
			const scoreParts = action.score.split('-');
			if (scoreParts.length === 2) {
				const hScore = parseInt(scoreParts[0].trim(), 10);
				const aScore = parseInt(scoreParts[1].trim(), 10);
				if (!isNaN(hScore)) runningHomeScore = hScore;
				if (!isNaN(aScore)) runningAwayScore = aScore;
			}
		} else {
			if (action.scoreHome !== undefined) runningHomeScore = parseInt(action.scoreHome, 10);
			if (action.scoreAway !== undefined) runningAwayScore = parseInt(action.scoreAway, 10);
		}

		const eventType = normalizeLbaAction(action.description || action.texto || action.libelle, action.type || action.tipo);
		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType) ? 1 : 0;

		const teamId = action.team_id ? String(action.team_id) : (action.equipeId || action.idEquipo ? String(action.equipeId || action.idEquipo) : null);
		const playerId = action.player_id ? String(action.player_id) : (action.joueurId || action.idJugador ? String(action.joueurId || action.idJugador) : null);

		const actionId = action.action_id || action.id || i;

		events.push({
			event_id: `${competitionId}_${cleanGameId}_lba_pbp_${actionId}_${i}`,
			game_id: cleanGameId,
			competition_id: competitionId,
			period,
			clock: String(clockStr),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: action.subType || action.subtipo || action.sousType ? String(action.subType || action.subtipo || action.sousType) : null,
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: action.linked_action_id ? String(action.linked_action_id) : null,
			description: String(action.description || action.texto || action.libelle || ''),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: action.x ?? action.posX ?? action.coordX ?? null,
			loc_y: action.y ?? action.posY ?? action.coordY ?? null,
			shot_distance: action.distance ?? action.distancia ?? null,
			is_scoring_play: isScoring
		});
	}

	const stints = buildStintsFromEvents(cleanGameId, competitionId, events);

	return { events, stints };
}
