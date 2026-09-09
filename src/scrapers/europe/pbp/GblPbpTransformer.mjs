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
 * @description Parses clock strings (e.g. "09:45", "9:45", or "00:09:45") into remaining period seconds.
 * @param {string} clockStr - Display clock string
 * @returns {number}
 */
export function parseGblClock(clockStr) {
	if (!clockStr || typeof clockStr !== 'string') return 0;
	const clean = clockStr.trim();

	// Handle HH:MM:SS or MM:SS
	const parts = clean.split(':');
	if (parts.length === 3) {
		const mins = parseInt(parts[1], 10);
		const secs = parseFloat(parts[2]);
		if (!isNaN(mins) && !isNaN(secs)) {
			return (mins * 60) + secs;
		}
	} else if (parts.length === 2) {
		const mins = parseInt(parts[0], 10);
		const secs = parseFloat(parts[1]);
		if (!isNaN(mins) && !isNaN(secs)) {
			return (mins * 60) + secs;
		}
	}
	return 0;
}

/**
 * @description Normalizes ESAKE English and Greek event texts into standard event type codes.
 * @param {string} rawText - Raw event description
 * @param {string} [typeCode=''] - Raw event type code
 * @returns {string} Normalized event type code
 */
export function normalizeGblAction(rawText = '', typeCode = '') {
	const text = String(rawText || '').toLowerCase();
	const type = String(typeCode || '').toUpperCase();

	if (type === '3FGM' || text.includes('performed a 3 points') || text.includes('made a 3 points') || text.includes('3 points jump shot') && !text.includes('missed') || text.includes('εύστοχο τρίποντο') || text.includes('3pt made')) {
		if (text.includes('missed') || text.includes('άστοχο')) return '3FGA';
		return '3FGM';
	}
	if (type === '3FGA' || text.includes('missed a 3 points') || text.includes('3 points jump shot missed') || text.includes('άστοχο τρίποντο') || text.includes('3pt miss')) {
		return '3FGA';
	}
	if (type === '2FGM' || text.includes('performed a 2 points') || text.includes('made a 2 points') || text.includes('lay-up') || text.includes('dunk') || text.includes('εύστοχο δίποντο') || text.includes('2pt made')) {
		if (text.includes('missed') || text.includes('άστοχο')) return '2FGA';
		return '2FGM';
	}
	if (type === '2FGA' || text.includes('missed a 2 points') || text.includes('2 points jump shot missed') || text.includes('άστοχο δίποντο') || text.includes('2pt miss')) {
		return '2FGA';
	}
	if (type === 'FTM' || text.includes('made a free throw') || text.includes('free throw made') || text.includes('εύστοχη βολή') || text.includes('ft made')) {
		if (text.includes('missed') || text.includes('άστοχη')) return 'FTA';
		return 'FTM';
	}
	if (type === 'FTA' || text.includes('missed a free throw') || text.includes('free throw missed') || text.includes('άστοχη βολή') || text.includes('ft miss')) {
		return 'FTA';
	}
	if (type === 'ORB' || text.includes('offensive rebound') || text.includes('επιθετικό ριμπάουντ')) {
		return 'ORB';
	}
	if (type === 'DRB' || text.includes('defensive rebound') || text.includes('αμυντικό ριμπάουντ') || text.includes('rebound') || text.includes('ριμπάουντ')) {
		return 'DRB';
	}
	if (type === 'TOV' || text.includes('bad pass') || text.includes('turnover') || text.includes('out of bounds') || text.includes('traveling') || text.includes('λάθος')) {
		return 'TOV';
	}
	if (type === 'BLK' || text.includes('blocked') || text.includes('τάπα') || text.includes('κοψιμο') || text.includes('block')) {
		return 'BLK';
	}
	if (type === 'STL' || text.includes('steal') || text.includes('κλέψιμο')) {
		return 'STL';
	}
	if (type === 'FOUL' || text.includes('foul') || text.includes('commited a personal foul') || text.includes('φάουλ')) {
		return 'FOUL';
	}
	if (type === 'SUB' || text.includes('entered the court') || text.includes('left the court') || text.includes('αλλαγή') || text.includes('substitut')) {
		return 'SUB';
	}

	return type || 'OTHER';
}

/**
 * @description Lineup State Machine for GBL PBP events.
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

			const descLower = String(evt.description || '').toLowerCase();
			const isSub = typeUpper === 'SUB' || descLower.includes('entered the court') || descLower.includes('left the court') || descLower.includes('αλλαγή');

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
					const isOut = descLower.includes('left the court') || descLower.includes('out');
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
 * @description Main transformation function for Greek Basketball League (GBL / ESAKE) raw PBP JSON payloads.
 * @param {string} gameId
 * @param {Object} rawJson
 * @returns {{ events: Object[], stints: Object[] }}
 */
export function transformGblPbp(gameId, rawJson) {
	if (!rawJson) return { events: [], stints: [] };

	const seasonYear = rawJson.seasonYear || '2026';
	const competitionId = rawJson.competitionId || `GBL${seasonYear}`;

	let rawEvents = [];
	if (Array.isArray(rawJson.events)) {
		rawEvents = rawJson.events;
	} else if (rawJson.pbp && Array.isArray(rawJson.pbp.Rows)) {
		rawEvents = rawJson.pbp.Rows;
	} else if (rawJson.pbp && Array.isArray(rawJson.pbp.actions)) {
		rawEvents = rawJson.pbp.actions;
	} else if (Array.isArray(rawJson.rows)) {
		rawEvents = rawJson.rows;
	} else if (Array.isArray(rawJson.plays)) {
		rawEvents = rawJson.plays;
	} else if (Array.isArray(rawJson)) {
		rawEvents = rawJson;
	}

	const events = [];
	let currentPeriod = 1;
	let runningHomeScore = 0;
	let runningAwayScore = 0;

	for (let i = 0; i < rawEvents.length; i++) {
		const action = rawEvents[i];
		const desc = action.description || action.PLAYINFO || action.text || '';

		// Period detection from description or action property
		if (action.period || action.PERIOD || action.quarter) {
			currentPeriod = parseInt(action.period || action.PERIOD || action.quarter, 10);
		} else if (desc.includes('Start of quarter') || desc.includes('Start of Period')) {
			const pMatch = desc.match(/\d+/);
			if (pMatch) currentPeriod = parseInt(pMatch[0], 10);
		}

		// Score extraction
		if (action.score_line) {
			const sMatch = String(action.score_line).match(/(\d+)\s*[:\-]\s*(\d+)/);
			if (sMatch) {
				runningHomeScore = parseInt(sMatch[1], 10);
				runningAwayScore = parseInt(sMatch[2], 10);
			}
		} else if (action.POINTS_A !== undefined && action.POINTS_B !== undefined) {
			runningHomeScore = parseInt(action.POINTS_A, 10);
			runningAwayScore = parseInt(action.POINTS_B, 10);
		} else {
			const inlineScoreMatch = desc.match(/\b(\d+)\s*:\s*(\d+)\b/);
			if (inlineScoreMatch) {
				runningHomeScore = parseInt(inlineScoreMatch[1], 10);
				runningAwayScore = parseInt(inlineScoreMatch[2], 10);
			}
		}

		// Player jersey/name extraction: "(25) Alec PETERS performed..." or action fields
		const playerMatch = desc.match(/\((\d+)\)\s+([A-Za-z\s\-]+)/);
		const playerNum = playerMatch ? playerMatch[1] : null;
		const playerName = playerMatch ? playerMatch[2].trim() : null;

		const playerId = action.player_id || action.PLAYER_ID || (playerNum ? `GBL_${playerNum}_${playerName.toLowerCase().replace(/\s+/g, '-')}` : null);
		const teamId = action.team_id || action.team_code || action.CODETEAM || action.TEAM || null;

		const clockRaw = action.clock || action.MARKERTIME || desc.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "10:00";
		const secondsRemaining = parseGblClock(clockRaw);
		const gameSecondsRemaining = calculateGameSecondsRemaining(currentPeriod, secondsRemaining);

		const rawType = action.event_type || action.PLAYTYPE || action.type || '';
		const eventType = normalizeGblAction(desc, rawType);
		const isScoring = ['2FGM', '3FGM', 'FTM'].includes(eventType);

		const actionId = action.raw_index ?? action.NUMBEROFPLAY ?? action.id ?? (i + 1);

		events.push({
			event_id: `${competitionId}_${gameId}_gbl_pbp_${actionId}_${i}`,
			game_id: String(gameId),
			competition_id: competitionId,
			period: currentPeriod,
			clock: String(clockRaw),
			seconds_remaining: secondsRemaining,
			game_seconds_remaining: gameSecondsRemaining,
			event_type: eventType,
			sub_type: action.sub_type || action.TYPE || null,
			team_id: teamId ? String(teamId) : null,
			player_id: playerId ? String(playerId) : null,
			secondary_player_id: action.secondary_player_id || action.PASSING_PLAYER_ID || null,
			description: String(desc),
			home_score: runningHomeScore,
			away_score: runningAwayScore,
			loc_x: action.loc_x ?? action.COORD_X ?? null,
			loc_y: action.loc_y ?? action.COORD_Y ?? null,
			shot_distance: action.shot_distance ?? action.DISTANCE ?? null,
			is_scoring_play: isScoring ? 1 : 0
		});
	}

	const stints = buildStintsFromEvents(gameId, competitionId, events);

	return { events, stints };
}
