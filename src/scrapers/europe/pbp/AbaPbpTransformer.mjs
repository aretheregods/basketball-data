/**
 * @file AbaPbpTransformer.mjs
 * @description Transformer for Adriatic ABA League Play-by-Play streams.
 * Parses FIBA regulation (600s) and overtime (300s) clocks, normalizes multilingual English and Serbo-Croatian
 * play descriptions into standard event types, and tracks substitution state machines to generate 5-on-5 stint intervals.
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
 * @description Parses ABA clock string into remaining period seconds (0-600s).
 * Handles formats like "00:09:45", "09:45", "10:00", or numeric inputs.
 * @param {string|number} [clockStr] - Clock value
 * @returns {number} Seconds remaining in period
 */
export function parseAbaClock(clockStr) {
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
 * @description Normalizes multilingual (English & Serbo-Croatian) ABA action codes and descriptions to standard event codes.
 * @param {string} textRaw - Description or text
 * @param {string} [typeCode=''] - Code type
 * @returns {string} Normalized event code
 */
export function normalizeAbaAction(textRaw, typeCode = '') {
	const code = String(typeCode || '').toUpperCase().trim();
	const text = String(textRaw || '').toLowerCase().trim();

	if (code === '3FGM' || code === '3PT_MADE' || code === '3FGA' || code === '2FGM' || code === '2FGA' || code === 'FTM' || code === 'FTA' || code === 'SUB' || code === 'ORB' || code === 'DRB' || code === 'TOV' || code === 'STL' || code === 'FOUL' || code === 'BLK') {
		return code;
	}

	// Code checks
	if (code.includes('3PT') || code.includes('3FG') || code.includes('THREE')) {
		if (text.includes('miss') || text.includes('promaš') || text.includes('prolaš')) return '3FGA';
		return '3FGM';
	}
	if (code.includes('2PT') || code.includes('2FG') || code.includes('TWO') || code.includes('LAYUP') || code.includes('DUNK')) {
		if (text.includes('miss') || text.includes('promaš') || text.includes('prolaš')) return '2FGA';
		return '2FGM';
	}
	if (code.includes('FT') || code.includes('FREE')) {
		if (text.includes('miss') || text.includes('promaš') || text.includes('prolaš')) return 'FTA';
		return 'FTM';
	}

	// Text checks (English & Serbo-Croatian)
	if (text.includes('3pt') || text.includes('3 pt') || text.includes('trojka') || text.includes('3 pts')) {
		if (text.includes('made') || text.includes('successful') || text.includes('pogođen') || text.includes('postigao') || text.includes('ubacio')) return '3FGM';
		if (text.includes('miss') || text.includes('promaš') || text.includes('prolaš')) return '3FGA';
		return '3FGM';
	}
	if (text.includes('2pt') || text.includes('2 pt') || text.includes('dvojka') || text.includes('dunk') || text.includes('zakucavanje') || text.includes('polaganje')) {
		if (text.includes('made') || text.includes('successful') || text.includes('pogođen') || text.includes('postigao') || text.includes('ubacio')) return '2FGM';
		if (text.includes('miss') || text.includes('promaš') || text.includes('prolaš')) return '2FGA';
		return '2FGM';
	}
	if (text.includes('free throw') || text.includes('slobodno bacanje') || text.includes('bacanje')) {
		if (text.includes('made') || text.includes('pogođen') || text.includes('postigao') || text.includes('ubacio')) return 'FTM';
		if (text.includes('miss') || text.includes('promaš') || text.includes('prolaš')) return 'FTA';
		return 'FTM';
	}
	if (text.includes('offensive rebound') || text.includes('skok u napadu')) {
		return 'ORB';
	}
	if (text.includes('defensive rebound') || text.includes('skok u odbrani') || text.includes('skok u obrani') || text.includes('skok')) {
		return 'DRB';
	}
	if (text.includes('turnover') || text.includes('izgubljena') || text.includes('koraci') || text.includes('pogreška')) {
		return 'TOV';
	}
	if (text.includes('steal') || text.includes('osvojena') || text.includes('ukradena')) {
		return 'STL';
	}
	if (text.includes('foul') || text.includes('greška') || text.includes('faul') || text.includes('lična')) {
		return 'FOUL';
	}
	if (text.includes('block') || text.includes('blokada')) {
		return 'BLK';
	}
	if (text.includes('substitut') || text.includes('izmena') || text.includes('zamjena') || text.includes('ulazi') || text.includes('izlazi')) {
		return 'SUB';
	}

	return code || 'OTHER';
}

/**
 * @description Lineup State Machine for Adriatic ABA PBP events.
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
				descLower.includes('substitution') || descLower.includes('izmena') || descLower.includes('zamjena') ||
				descLower.includes('ulazi') || descLower.includes('izlazi');

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
					const isOut = descLower.includes('izlazi') || descLower.includes('out') || subTypeUpper === 'OUT';
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
 * @description Transforms raw Adriatic ABA play-by-play payload into standardized event rows and stint intervals.
 * @param {string} gameId - Game identifier
 * @param {Object} rawPayload - Raw ABA play-by-play payload object
 * @returns {{ events: Object[], stints: Object[] }}
 */
/**
 * @description Extracts 4-digit season year from a game ID slug or code.
 * @param {string} gameId
 * @param {string} [defaultYear='2025']
 * @returns {string}
 */
function extractSeasonYear(gameId, defaultYear = '2025') {
	const str = String(gameId || '').trim();
	const match = str.match(/(?:^|[-_])[A-Za-z](\d{2,4})(?:_|$)/i);
	if (match) {
		let yr = match[1];
		if (yr.length === 2) yr = '20' + yr;
		return yr;
	}
	return String(defaultYear);
}

/**
 * @description Normalizes game ID to standard format (e.g. V2025_123 or matchup-V2025_123)
 * @param {string} gameId
 * @param {string} seasonYear
 * @returns {string}
 */
function normalizeEuropeGameId(gameId, seasonYear) {
	const str = String(gameId || '').trim();
	if (str.includes('_')) {
		return str;
	}
	return `V${seasonYear}_${str}`;
}

export function transformAbaPbp(gameId, rawPayload, fallbackYear = '2025') {
	if (!rawPayload) return { events: [], stints: [] };

	const cleanGameId = String(gameId || '').trim();
	const seasonYear = rawPayload.seasonYear || extractSeasonYear(cleanGameId, fallbackYear);
	const competitionId = rawPayload.competitionId || `ABA${seasonYear}`;
	const normalizedGameId = normalizeEuropeGameId(cleanGameId, seasonYear);

	// Extract raw actions array based on source payload format
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
		if (a.raw_index !== undefined && b.raw_index !== undefined) {
			return (a.raw_index ?? 0) - (b.raw_index ?? 0);
		}
		const pA = parseInt(a.period || 1, 10);
		const pB = parseInt(b.period || 1, 10);
		if (pA !== pB) return pA - pB;

		const clockA = parseAbaClock(a.gt || a.time || a.clock);
		const clockB = parseAbaClock(b.gt || b.time || b.clock);
		return clockB - clockA;
	});

	const events = [];
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < actions.length; i++) {
		const action = actions[i];

		const period = parseInt(action.period || 1, 10);
		const rawClock = action.gt || action.time || action.clock || "10:00";
		let clockStr = String(rawClock);
		if (clockStr.startsWith("00:")) {
			clockStr = clockStr.substring(3);
		}

		const secondsRemaining = parseAbaClock(rawClock);
		const gameSecondsRemaining = calculateGameSecondsRemaining(period, secondsRemaining);

		if (action.s1 !== undefined && action.s1 !== null) {
			runningHomeScore = parseInt(action.s1, 10);
		} else if (action.home_score !== undefined && action.home_score !== null) {
			runningHomeScore = parseInt(action.home_score, 10);
		}

		if (action.s2 !== undefined && action.s2 !== null) {
			runningAwayScore = parseInt(action.s2, 10);
		} else if (action.away_score !== undefined && action.away_score !== null) {
			runningAwayScore = parseInt(action.away_score, 10);
		}

		if (action.score_line && typeof action.score_line === 'string') {
			const parts = action.score_line.split('-').map(s => s.trim());
			if (parts.length === 2) {
				const h = parseInt(parts[0], 10);
				const a = parseInt(parts[1], 10);
				if (!isNaN(h)) runningHomeScore = h;
				if (!isNaN(a)) runningAwayScore = a;
			}
		} else if (action.score && typeof action.score === 'string') {
			const parts = action.score.split(':').map(s => s.trim());
			if (parts.length === 2) {
				const h = parseInt(parts[0], 10);
				const a = parseInt(parts[1], 10);
				if (!isNaN(h)) runningHomeScore = h;
				if (!isNaN(a)) runningAwayScore = a;
			}
		}

		const desc = action.text || action.description || action.desc || '';
		const eventType = normalizeAbaAction(desc, action.actionType || action.type);
		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType) ? 1 : 0;

		const teamId = action.tno ? String(action.tno) : (action.team ? String(action.team) : (action.team_id ? String(action.team_id) : null));
		const playerId = action.personId ? String(action.personId) : (action.playerId ? String(action.playerId) : (action.player_id ? String(action.player_id) : null));
		const secondaryPlayerId = action.subPersonId || action.secondary_player_id || null;

		const actionNumber = action.actionNumber ?? action.raw_index ?? i;

		events.push({
			event_id: `${competitionId}_${normalizedGameId}_aba_pbp_${actionNumber}_${i}`,
			game_id: normalizedGameId,
			competition_id: competitionId,
			period,
			clock: String(clockStr),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: action.subType ? String(action.subType) : null,
			team_id: teamId,
			player_id: playerId,
			secondary_player_id: secondaryPlayerId,
			description: String(desc),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: action.x ?? action.loc_x ?? null,
			loc_y: action.y ?? action.loc_y ?? null,
			shot_distance: action.distance ?? action.shot_distance ?? null,
			is_scoring_play: isScoring
		});
	}

	const stints = buildStintsFromEvents(normalizedGameId, competitionId, events);

	return { events, stints };
}
