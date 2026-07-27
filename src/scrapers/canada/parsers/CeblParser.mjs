/**
 * @file CeblParser.mjs
 * @description Zero-dependency JSON parser for FIBA LiveStats/Genius Sports CEBL box score pages.
 */

/**
 * @description Helper to slugify and clean strings.
 * @param {string} text - The input text
 * @returns {string} - The slugified string
 */
export function slugify(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/[\s-]+/g, '-');
}

/**
 * @description Parses FIBA LiveStats JSON payload into Canada BoxScore Schema.
 * @param {string|Object} rawJson - Raw JSON string or parsed object
 * @param {string} gameId - Unique game ID
 * @param {string|number} season - Season year
 * @returns {Object} Cleaned and structured box score object
 * @throws {Error} If extracted player records are 0
 */
export function parseCeblFibaJson(rawJson, gameId, season) {
	const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;

	if (!data || !data.tm) {
		throw new Error(`[FIBA JSON Error] Invalid or missing JSON for game ${gameId}`);
	}

	// Extract game date (typically gDate is "DD/MM/YYYY" in FIBA LiveStats)
	let gameDate = '';
	if (data.gDate) {
		const parts = String(data.gDate).split('/');
		if (parts.length === 3) {
			const d = parts[0].padStart(2, '0');
			const m = parts[1].padStart(2, '0');
			const y = parts[2];
			gameDate = `${y}-${m}-${d}`;
		} else if (String(data.gDate).includes('-')) {
			gameDate = String(data.gDate);
		}
	}
	if (!gameDate) {
		gameDate = `${season}-07-15`; // Default mid-summer date for CEBL
	}

	const parseTeam = (teamObj) => {
		if (!teamObj) {
			return {
				teamId: 'TEAM',
				teamName: 'Unknown Team',
				score: 0,
				players: []
			};
		}

		const teamName = teamObj.sName || teamObj.sShortName || 'Unknown Team';
		const score = parseInt(teamObj.sScore || 0, 10);
		const playersMap = teamObj.pl || {};
		const roster = Object.values(playersMap);

		const players = roster.map(p => {
			const minStr = String(p.sMinutes || '00:00').trim();
			// Ignore players who did not enter the game
			if (!minStr || minStr === '00:00' || minStr === '0' || minStr === '00' || minStr === '-') {
				return null;
			}

			const firstName = p.internationalFirstName || p.sFirstName || p.sFirstNameInitial || '';
			const lastName = p.internationalLastName || p.sLastName || p.sName || '';
			const fullName = `${firstName} ${lastName}`.trim() || p.sShortName || 'Unknown Player';

			const pts = parseInt(p.sPoints || p.sPts || 0, 10);
			const fgm = parseInt(p.sFieldGoalsMade || p.sFgm || 0, 10);
			const fga = parseInt(p.sFieldGoalsAttempted || p.sFga || 0, 10);
			const fg3m = parseInt(p.sThreePointersMade || p.sFg3m || 0, 10);
			const fg3a = parseInt(p.sThreePointersAttempted || p.sFg3a || 0, 10);
			const ftm = parseInt(p.sFreeThrowsMade || p.sFtm || 0, 10);
			const fta = parseInt(p.sFreeThrowsAttempted || p.sFta || 0, 10);
			const oreb = parseInt(p.sReboundsOffensive || p.sOreb || 0, 10);
			const dreb = parseInt(p.sReboundsDefensive || p.sDreb || 0, 10);
			const reb = parseInt(p.sReboundsTot || p.sRebs || p.sReb || (oreb + dreb) || 0, 10);
			const ast = parseInt(p.sAssists || p.sAst || 0, 10);
			const stl = parseInt(p.sSteals || p.sStl || 0, 10);
			const blk = parseInt(p.sBlocksTot || p.sBlk || 0, 10);
			const tov = parseInt(p.sTurnovers || p.sTo || p.sTov || 0, 10);
			const pf = parseInt(p.sFoulsPersonal || p.sFouls || p.sPf || 0, 10);
			const plus_minus = parseInt(p.sPlusMinus || p.sPlusMinusPoints || 0, 10);

			return {
				playerId: slugify(fullName),
				playerName: fullName,
				statistics: {
					min: minStr,
					pts,
					fgm,
					fga,
					fg3m,
					fg3a,
					ftm,
					fta,
					oreb,
					dreb,
					reb,
					ast,
					stl,
					blk,
					tov,
					pf,
					plus_minus
				}
			};
		}).filter(Boolean);

		return {
			teamId: String(teamObj.sShortName || teamName).toUpperCase().substring(0, 4),
			teamName,
			score,
			players
		};
	};

	// FIBA LiveStats team keys are typically '1' (Home) and '2' (Away)
	const homeTeam = parseTeam(data.tm?.['1']);
	const awayTeam = parseTeam(data.tm?.['2']);

	// Fail-Fast Assertion
	const totalPlayersCount = homeTeam.players.length + awayTeam.players.length;
	if (totalPlayersCount === 0) {
		throw new Error(`[FIBA JSON Error] Extracted 0 player records for CEBL game ${gameId}`);
	}

	return {
		gameId,
		season: String(season),
		gameDate,
		homeTeam,
		awayTeam
	};
}

/**
 * @description Dummy/legacy parseCeblHtml method kept for safety.
 * @returns {Object}
 */
export function parseCeblHtml() {
	return {};
}

export default { parseCeblFibaJson, parseCeblHtml };
