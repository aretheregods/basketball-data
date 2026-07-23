import fs from 'fs/promises';
import path from 'path';
import { BaseNormalizer, EuropeanEntityResolver } from '#utils';

/**
 * @description Transforms European raw boxscore JSON payloads into clean, canonical database-ready arrays.
 * Handles entity resolution and populates referential supplemental structures.
 *
 * @param {string} rawDir - Directory containing the raw JSON files
 * @param {string|number} year - The season year
 * @returns {Promise<Object>} Mapped collection containing players, teams, and referential data
 */
export async function transformEurope(rawDir, year) {
	let files = [];
	try {
		files = await fs.readdir(rawDir);
	} catch (error) {
		console.warn(`⚠️ Raw Europe directory does not exist: ${rawDir}`);
		return { players: [], teams: [] };
	}

	const jsonFiles = files.filter(f => f.endsWith('.json'));
	const resolver = new EuropeanEntityResolver();

	const allPlayers = [];
	const allTeams = [];

	// Supplemental Europe tables
	/** @type {Map<string, Object>} */
	const competitionsMap = new Map();
	/** @type {Map<string, Object>} */
	const teamsMap = new Map();
	/** @type {Map<string, Object>} */
	const teamAliasesMap = new Map();
	/** @type {Map<string, Object>} */
	const playersMap = new Map();
	/** @type {Map<string, Object>} */
	const gamesMap = new Map();

	for (const fileName of jsonFiles) {
		const filePath = path.join(rawDir, fileName);
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const raw = JSON.parse(content);

			if (!raw || !raw.gameId) {
				continue;
			}

			const { gameId, competitionId, seasonId, gameDate, homeTeam, awayTeam } = raw;

			// Skip unplayed/postponed/future games
			if (homeTeam.teamName === 'Unplayed' || !homeTeam.players || homeTeam.players.length === 0) {
				continue;
			}

			// Define competition details and type
			const compNames = {
				euroleague: 'EuroLeague',
				eurocup: 'EuroCup',
				bcl: 'Basketball Champions League',
				acb: 'Liga ACB',
				bsl: 'Basketbol Süper Ligi',
				bbl: 'Basketball Bundesliga',
				lnb: 'LNB Pro A',
				lba: 'Lega Basket Serie A',
				aba: 'ABA League',
				vtb: 'VTB United League',
				gbl: 'Greek Basketball League'
			};
			const compName = compNames[competitionId] || competitionId.toUpperCase();
			const compType = ['euroleague', 'eurocup', 'bcl'].includes(competitionId) ? 'continental' : 'domestic';

			competitionsMap.set(competitionId, {
				id: competitionId,
				name: compName,
				type: compType
			});

			// Resolve team entities
			const resolvedHomeId = resolver.resolveTeam(homeTeam.teamName);
			const resolvedAwayId = resolver.resolveTeam(awayTeam.teamName);

			// Populate Teams & Team Aliases Maps
			teamsMap.set(resolvedHomeId, {
				id: resolvedHomeId,
				canonical_name: homeTeam.teamName,
				country_code: 'EUR',
				primary_domestic_league_id: null
			});
			teamAliasesMap.set(homeTeam.teamName.toUpperCase(), {
				alias: homeTeam.teamName,
				team_id: resolvedHomeId
			});

			teamsMap.set(resolvedAwayId, {
				id: resolvedAwayId,
				canonical_name: awayTeam.teamName,
				country_code: 'EUR',
				primary_domestic_league_id: null
			});
			teamAliasesMap.set(awayTeam.teamName.toUpperCase(), {
				alias: awayTeam.teamName,
				team_id: resolvedAwayId
			});

			// Populate Game Map
			gamesMap.set(gameId, {
				id: gameId,
				competition_id: competitionId,
				season_id: String(seasonId),
				game_date: gameDate,
				home_team_id: resolvedHomeId,
				away_team_id: resolvedAwayId,
				home_score: homeTeam.score,
				away_score: awayTeam.score
			});

			// Helper to process team boxscore
			const processTeam = (teamObj, resolvedTeamId, opponentId, isHome) => {
				const teamName = teamObj.teamName;
				const players = teamObj.players || [];

				let teamPts = Number(teamObj.score ?? 0);
				let teamFgm = 0, teamFga = 0, teamFg3m = 0, teamFg3a = 0;
				let teamFtm = 0, teamFta = 0, teamOreb = 0, teamDreb = 0, teamReb = 0;
				let teamAst = 0, teamStl = 0, teamBlk = 0, teamTov = 0, teamPf = 0;

				for (const p of players) {
					const resolvedPlayerId = resolver.resolvePlayer(p.playerName);
					const normalizedPlayerName = BaseNormalizer.normalizeName(p.playerName);

					playersMap.set(resolvedPlayerId, {
						id: resolvedPlayerId,
						canonical_name: p.playerName,
						normalized_name: normalizedPlayerName
					});

					const stats = p.statistics || {};
					const pts = Number(stats.pts ?? 0);
					const fgm = Number(stats.fgm ?? 0);
					const fga = Number(stats.fga ?? 0);
					const fg3m = Number(stats.fg3m ?? 0);
					const fg3a = Number(stats.fg3a ?? 0);
					const ftm = Number(stats.ftm ?? 0);
					const fta = Number(stats.fta ?? 0);
					const oreb = Number(stats.oreb ?? 0);
					const dreb = Number(stats.dreb ?? 0);
					const reb = Number(stats.reb ?? (oreb + dreb));
					const ast = Number(stats.ast ?? 0);
					const stl = Number(stats.stl ?? 0);
					const blk = Number(stats.blk ?? 0);
					const tov = Number(stats.tov ?? 0);
					const pf = Number(stats.pf ?? 0);
					const minutesFloat = BaseNormalizer.parseMinutesToFloat(stats.min);

					// Accumulate for team aggregate if empty
					teamFgm += fgm; teamFga += fga; teamFg3m += fg3m; teamFg3a += fg3a;
					teamFtm += ftm; teamFta += fta; teamOreb += oreb; teamDreb += dreb; teamReb += reb;
					teamAst += ast; teamStl += stl; teamBlk += blk; teamTov += tov; teamPf += pf;

					allPlayers.push({
						game_id: gameId,
						player_id: resolvedPlayerId,
						player_name: BaseNormalizer.cleanString(p.playerName),
						normalized_name: normalizedPlayerName,
						team_id: resolvedTeamId,
						team_abbreviation: String(teamObj.teamId || resolvedTeamId).toUpperCase().substring(0, 4),
						team_city: 'Europe',
						start_position: '',
						comment: '',
						min: String(minutesFloat),
						fgm,
						fga,
						fg_pct: fga > 0 ? Number((fgm / fga).toFixed(4)) : 0.0,
						fg3m,
						fg3a,
						fg3_pct: fg3a > 0 ? Number((fg3m / fg3a).toFixed(4)) : 0.0,
						ftm,
						fta,
						ft_pct: fta > 0 ? Number((ftm / fta).toFixed(4)) : 0.0,
						oreb,
						dreb,
						reb,
						ast,
						stl,
						blk,
						tov,
						pf,
						pts,
						plus_minus: Number(stats.plus_minus ?? 0.0),
						ts_pct: BaseNormalizer.calculateTSPct(pts, fga, fta),
						efg_pct: BaseNormalizer.calculateEFGPct(fgm, fg3m, fga),
						game_score: BaseNormalizer.calculateGameScore(
							pts, fgm, fga, fta, ftm, oreb, dreb, stl, ast, blk, pf, tov
						),
						season: String(year),
						league: competitionId,
						synced: 0
					});
				}

				// If team stats are present in the raw data, use them, otherwise use aggregates
				const rawTStats = teamObj.statistics || {};
				const finalFgm = Number(rawTStats.fgm ?? teamFgm);
				const finalFga = Number(rawTStats.fga ?? teamFga);
				const finalFg3m = Number(rawTStats.fg3m ?? teamFg3m);
				const finalFg3a = Number(rawTStats.fg3a ?? teamFg3a);
				const finalFtm = Number(rawTStats.ftm ?? teamFtm);
				const finalFta = Number(rawTStats.fta ?? teamFta);
				const finalOreb = Number(rawTStats.oreb ?? teamOreb);
				const finalDreb = Number(rawTStats.dreb ?? teamDreb);
				const finalReb = Number(rawTStats.reb ?? teamReb);
				const finalAst = Number(rawTStats.ast ?? teamAst);
				const finalStl = Number(rawTStats.stl ?? teamStl);
				const finalBlk = Number(rawTStats.blk ?? teamBlk);
				const finalTov = Number(rawTStats.tov ?? teamTov);
				const finalPf = Number(rawTStats.pf ?? teamPf);

				allTeams.push({
					game_id: gameId,
					team_id: resolvedTeamId,
					team_name: BaseNormalizer.cleanString(teamName),
					team_abbreviation: String(teamObj.teamId || resolvedTeamId).toUpperCase().substring(0, 4),
					team_city: 'Europe',
					min: '200',
					fgm: finalFgm,
					fga: finalFga,
					fg_pct: finalFga > 0 ? Number((finalFgm / finalFga).toFixed(4)) : 0.0,
					fg3m: finalFg3m,
					fg3a: finalFg3a,
					fg3_pct: finalFg3a > 0 ? Number((finalFg3m / finalFg3a).toFixed(4)) : 0.0,
					ftm: finalFtm,
					fta: finalFta,
					ft_pct: finalFta > 0 ? Number((finalFtm / finalFta).toFixed(4)) : 0.0,
					oreb: finalOreb,
					dreb: finalDreb,
					reb: finalReb,
					ast: finalAst,
					stl: finalStl,
					blk: finalBlk,
					tov: finalTov,
					pf: finalPf,
					pts: teamPts,
					plus_minus: Number(isHome ? (teamPts - awayTeam.score) : (teamPts - homeTeam.score)),
					ts_pct: BaseNormalizer.calculateTSPct(teamPts, finalFga, finalFta),
					efg_pct: BaseNormalizer.calculateEFGPct(finalFgm, finalFg3m, finalFga),
					season: String(year),
					league: competitionId,
					synced: 0
				});
			};

			processTeam(homeTeam, resolvedHomeId, resolvedAwayId, true);
			processTeam(awayTeam, resolvedAwayId, resolvedHomeId, false);

		} catch (error) {
			console.error(`❌ Failed to transform Europe file ${filePath}:`, error);
			throw error;
		}
	}

	return {
		players: allPlayers,
		teams: allTeams,
		europe_competitions: Array.from(competitionsMap.values()),
		europe_teams: Array.from(teamsMap.values()),
		europe_team_aliases: Array.from(teamAliasesMap.values()),
		europe_players: Array.from(playersMap.values()),
		europe_games: Array.from(gamesMap.values())
	};
}
