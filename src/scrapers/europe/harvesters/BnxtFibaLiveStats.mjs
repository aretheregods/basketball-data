/**
 * @file BnxtFibaLiveStats.mjs
 * @description Fetches and maps public BNXT Genius Sports LiveStats game feeds.
 */

const FIBA_DATA_URL = 'https://fibalivestats.dcd.shared.geniussports.com/data';

/**
 * @description Fetches a match's public Genius Sports LiveStats JSON feed.
 * @param {string|number} matchId - Genius LiveStats match identifier.
 * @param {typeof fetch} [fetchImpl=fetch] - Fetch implementation, injectable for tests.
 * @returns {Promise<Object|null>} The validated match payload, or null if unavailable.
 * @throws {Error} Throws when the request fails or the response is not valid LiveStats data.
 */
export async function fetchBnxtFibaLiveStats(matchId, fetchImpl = fetch) {
	if (!matchId) return null;
	const url = `${FIBA_DATA_URL}/${encodeURIComponent(String(matchId))}/data.json`;
	const response = await fetchImpl(url, {
		headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
	});
	if (!response.ok) {
		throw new Error(`FIBA LiveStats request failed for match ${matchId}: HTTP ${response.status}`);
	}
	const data = await response.json();
	if (!data || typeof data !== 'object' || !(data.tm || data.pbp)) {
		throw new Error(`FIBA LiveStats returned an invalid payload for match ${matchId}`);
	}
	return data;
}

/**
 * @description Converts a Genius LiveStats team/player block to BNXT's unified box-score shape.
 * @param {Object} rawTeam - Genius LiveStats team payload.
 * @param {string} teamKey - Team number from the LiveStats payload.
 * @param {string|number} matchId - Genius match identifier.
 * @returns {Object} Unified team box score.
 */
function mapFibaTeam(rawTeam, teamKey, matchId) {
	const players = Object.entries(rawTeam.pl || {}).map(([playerNo, player]) => {
		const fullName = [player.internationalFirstName || player.firstName, player.internationalFamilyName || player.familyName]
			.filter(Boolean).join(' ').trim() || player.name || `Player ${playerNo}`;
		return {
			playerId: `fiba-${matchId}-${teamKey}-${playerNo}`,
			playerName: fullName,
			jerseyNumber: player.shirtNumber || null,
			statistics: {
				min: player.sMinutes || '0:00',
				pts: Number(player.sPoints || 0),
				fgm: Number(player.sFieldGoalsMade || 0),
				fga: Number(player.sFieldGoalsAttempted || 0),
				fg3m: Number(player.sThreePointersMade || 0),
				fg3a: Number(player.sThreePointersAttempted || 0),
				ftm: Number(player.sFreeThrowsMade || 0),
				fta: Number(player.sFreeThrowsAttempted || 0),
				oreb: Number(player.sReboundsOffensive || 0),
				dreb: Number(player.sReboundsDefensive || 0),
				reb: Number(player.sReboundsTotal || 0),
				ast: Number(player.sAssists || 0),
				stl: Number(player.sSteals || 0),
				blk: Number(player.sBlocks || 0),
				tov: Number(player.sTurnovers || 0),
				pf: Number(player.sFoulsPersonal || 0),
				plus_minus: Number(player.sPlusMinusPoints || 0)
			},
			advancedStats: {
				pointsSecondChance: Number(player.sPointsSecondChance || 0),
				pointsFastBreak: Number(player.sPointsFastBreak || 0),
				pointsInThePaint: Number(player.sPointsInThePaint || 0),
				efficiency: player.eff_1 ?? null
			}
		};
	});
	const totals = {
		pts: Number(rawTeam.tot_sPoints ?? rawTeam.score ?? 0),
		fgm: Number(rawTeam.tot_sFieldGoalsMade || 0),
		fga: Number(rawTeam.tot_sFieldGoalsAttempted || 0),
		fg3m: Number(rawTeam.tot_sThreePointersMade || 0),
		fg3a: Number(rawTeam.tot_sThreePointersAttempted || 0),
		ftm: Number(rawTeam.tot_sFreeThrowsMade || 0),
		fta: Number(rawTeam.tot_sFreeThrowsAttempted || 0),
		oreb: Number(rawTeam.tot_sReboundsOffensive || 0),
		dreb: Number(rawTeam.tot_sReboundsDefensive || 0),
		reb: Number(rawTeam.tot_sReboundsTotal || 0),
		ast: Number(rawTeam.tot_sAssists || 0),
		stl: Number(rawTeam.tot_sSteals || 0),
		blk: Number(rawTeam.tot_sBlocks || 0),
		tov: Number(rawTeam.tot_sTurnovers || 0),
		pf: Number(rawTeam.tot_sFoulsPersonal || 0)
	};
	return {
		teamId: rawTeam.code || `T${teamKey}`,
		teamName: rawTeam.nameInternational || rawTeam.name || `Team ${teamKey}`,
		score: Number(rawTeam.full_score ?? rawTeam.score ?? totals.pts),
		statistics: totals,
		advancedStats: {
			pointsFromTurnovers: Number(rawTeam.tot_sPointsFromTurnovers || 0),
			pointsSecondChance: Number(rawTeam.tot_sPointsSecondChance || 0),
			pointsFastBreak: Number(rawTeam.tot_sPointsFastBreak || 0),
			benchPoints: Number(rawTeam.tot_sBenchPoints || 0),
			pointsInThePaint: Number(rawTeam.tot_sPointsInThePaint || 0),
			biggestLead: Number(rawTeam.tot_sBiggestLead || 0),
			biggestScoringRun: Number(rawTeam.tot_sBiggestScoringRun || 0),
			leadChanges: Number(rawTeam.tot_sLeadChanges || 0)
		},
		players
	};
}

/**
 * @description Maps a Genius LiveStats game payload to the BNXT unified box-score shape.
 * LiveStats team keys 1 and 2 are the home and away sides respectively.
 * @param {Object} data - Genius LiveStats payload.
 * @param {Object} options - Game metadata.
 * @param {string} options.gameId - Repository game identifier.
 * @param {string} options.competitionId - Repository competition identifier.
 * @param {string} options.seasonYear - BNXT season end year.
 * @param {string|number} options.matchId - Genius match identifier.
 * @param {string} [options.gameDate] - Date from schedule metadata if available.
 * @returns {Object|null} Unified box score or null if team/player stats are absent.
 */
export function mapBnxtFibaBoxScore(data, { gameId, competitionId, seasonYear, matchId, gameDate = '' }) {
	const teams = data?.tm;
	if (!teams?.['1'] || !teams?.['2']) return null;
	const homeTeam = mapFibaTeam(teams['1'], '1', matchId);
	const awayTeam = mapFibaTeam(teams['2'], '2', matchId);
	return {
		gameId,
		competitionId,
		seasonId: seasonYear,
		gameDate,
		source: 'fiba_livestats',
		geniusMatchId: String(matchId),
		homeTeam,
		awayTeam,
		advancedStats: {
			period: Number(data.period || 0),
			periodLength: Number(data.periodLength || 10),
			periodsMax: Number(data.periodsMax || 4)
		}
	};
}
