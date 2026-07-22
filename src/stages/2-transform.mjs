import fs from 'fs/promises';
import path from 'path';
import { BaseNormalizer } from '#utils';

/**
 * @description Map helper to convert a Stats API result set (headers + rowSet) to objects.
 * @param {Object} resultSet - The result set object with headers and rowSet
 * @returns {Record<string, any>[]} - Array of mapped objects
 */
function mapResultSet(resultSet) {
	if (!resultSet || !Array.isArray(resultSet.headers) || !Array.isArray(resultSet.rowSet)) {
		return [];
	}
	const headers = resultSet.headers;
	return resultSet.rowSet.map(row => {
		/** @type {Record<string, any>} */
		const obj = {};
		row.forEach((value, index) => {
			obj[headers[index]] = value;
		});
		return obj;
	});
}

/**
 * @description Runs the transformation stage: loops through local raw JSON files,
 * cleans strings, calculates advanced basketball metrics (TS%, eFG%, Game Score),
 * and structures the data into flat database-ready records.
 * Saves the transformed data as cached JSON and returns the collections.
 *
 * @param {string} league - The lowercase league identifier (e.g., 'wnba')
 * @param {string|number} year - The season year (e.g., '2023')
 * @returns {Promise<{ players: Record<string, any>[], teams: Record<string, any>[] }>} - The transformed collections
 * @throws {Error} - If reading files or transformation fails
 */
export async function transformStage(league, year) {
	console.log(`⚙️ Starting Stage 2 [TRANSFORM] for ${league.toUpperCase()} - ${year}`);

	const rawDir = path.resolve('data/raw', league, String(year));
	let files = [];
	try {
		files = await fs.readdir(rawDir);
	} catch (error) {
		console.warn(`⚠️ Raw data directory does not exist or cannot be read: ${rawDir}`);
		return { players: [], teams: [] };
	}

	const jsonFiles = files.filter(f => f.endsWith('.json'));
	console.log(`📂 Found ${jsonFiles.length} raw JSON files to transform.`);

	const allPlayers = [];
	const allTeams = [];

	for (const fileName of jsonFiles) {
		const filePath = path.join(rawDir, fileName);
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const rawData = JSON.parse(content);

			if (!rawData) {
				continue;
			}

			if (league.toLowerCase() === 'nba') {
				// Direct flat Next.js structure parsing for NBA
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const processNBATeam = (teamObj) => {
					if (!teamObj) return;
					const teamId = Number(teamObj.teamId || 0);
					const teamName = teamObj.teamName ? BaseNormalizer.cleanString(teamObj.teamName) : '';
					const teamCity = teamObj.teamCity ? BaseNormalizer.cleanString(teamObj.teamCity) : '';
					const teamAbbrev = teamObj.teamTricode ? BaseNormalizer.cleanString(teamObj.teamTricode) : '';

					const tStats = teamObj.statistics || {};
					const pts = Number(tStats.points ?? 0);
					const fgm = Number(tStats.fieldGoalsMade ?? 0);
					const fga = Number(tStats.fieldGoalsAttempted ?? 0);
					const fg3m = Number(tStats.threePointersMade ?? 0);
					const fg3a = Number(tStats.threePointersAttempted ?? 0);
					const ftm = Number(tStats.freeThrowsMade ?? 0);
					const fta = Number(tStats.freeThrowsAttempted ?? 0);
					const oreb = Number(tStats.reboundsOffensive ?? 0);
					const dreb = Number(tStats.reboundsDefensive ?? 0);
					const stl = Number(tStats.steals ?? 0);
					const ast = Number(tStats.assists ?? 0);
					const blk = Number(tStats.blocks ?? 0);
					const pf = Number(tStats.foulsPersonal ?? 0);
					const tov = Number(tStats.turnovers ?? 0);

					const fullTeamName = `${teamCity} ${teamName}`.trim();

					allTeams.push({
						game_id: gameId,
						team_id: teamId,
						team_name: fullTeamName,
						team_abbreviation: teamAbbrev,
						team_city: teamCity,
						min: tStats.minutes ? String(BaseNormalizer.parseMinutesToFloat(tStats.minutes)) : null,
						fgm,
						fga,
						fg_pct: Number(tStats.fieldGoalsPercentage ?? 0.0),
						fg3m,
						fg3a,
						fg3_pct: Number(tStats.threePointersPercentage ?? 0.0),
						ftm,
						fta,
						ft_pct: Number(tStats.freeThrowsPercentage ?? 0.0),
						oreb,
						dreb,
						reb: Number(tStats.reboundsTotal ?? 0),
						ast,
						stl,
						blk,
						tov,
						pf,
						pts,
						plus_minus: Number(tStats.plusMinusPoints ?? 0.0),
						ts_pct: BaseNormalizer.calculateTSPct(pts, fga, fta),
						efg_pct: BaseNormalizer.calculateEFGPct(fgm, fg3m, fga),
						season: String(year),
						league: 'nba',
						synced: 0
					});

					const players = teamObj.players || [];
					for (const p of players) {
						const playerId = Number(p.personId || 0);
						if (!playerId) continue;

						const firstName = p.firstName || '';
						const familyName = p.familyName || '';
						const rawPlayerName = `${firstName} ${familyName}`.trim();

						const pStats = p.statistics || {};
						const pPts = Number(pStats.points ?? 0);
						const pFgm = Number(pStats.fieldGoalsMade ?? 0);
						const pFga = Number(pStats.fieldGoalsAttempted ?? 0);
						const pFg3m = Number(pStats.threePointersMade ?? 0);
						const pFg3a = Number(pStats.threePointersAttempted ?? 0);
						const pFtm = Number(pStats.freeThrowsMade ?? 0);
						const pFta = Number(pStats.freeThrowsAttempted ?? 0);
						const pOreb = Number(pStats.reboundsOffensive ?? 0);
						const pDreb = Number(pStats.reboundsDefensive ?? 0);
						const pStl = Number(pStats.steals ?? 0);
						const pAst = Number(pStats.assists ?? 0);
						const pBlk = Number(pStats.blocks ?? 0);
						const pPf = Number(pStats.foulsPersonal ?? 0);
						const pTov = Number(pStats.turnovers ?? 0);

						allPlayers.push({
							game_id: gameId,
							player_id: playerId,
							player_name: BaseNormalizer.cleanString(rawPlayerName),
							normalized_name: BaseNormalizer.normalizeName(rawPlayerName),
							team_id: teamId,
							team_abbreviation: teamAbbrev,
							team_city: teamCity,
							start_position: p.position ? BaseNormalizer.cleanString(p.position) : '',
							comment: p.comment ? BaseNormalizer.cleanString(p.comment) : '',
							min: pStats.minutes ? String(BaseNormalizer.parseMinutesToFloat(pStats.minutes)) : null,
							fgm: pFgm,
							fga: pFga,
							fg_pct: Number(pStats.fieldGoalsPercentage ?? 0.0),
							fg3m: pFg3m,
							fg3a: pFg3a,
							fg3_pct: Number(pStats.threePointersPercentage ?? 0.0),
							ftm: pFtm,
							fta: pFta,
							ft_pct: Number(pStats.freeThrowsPercentage ?? 0.0),
							oreb: pOreb,
							dreb: pDreb,
							reb: Number(pStats.reboundsTotal ?? 0),
							ast: pAst,
							stl: pStl,
							blk: pBlk,
							tov: pTov,
							pf: pPf,
							pts: pPts,
							plus_minus: Number(pStats.plusMinusPoints ?? 0.0),
							ts_pct: BaseNormalizer.calculateTSPct(pPts, pFga, pFta),
							efg_pct: BaseNormalizer.calculateEFGPct(pFgm, pFg3m, pFga),
							game_score: BaseNormalizer.calculateGameScore(
								pPts, pFgm, pFga, pFta, pFtm, pOreb, pDreb, pStl, pAst, pBlk, pPf, pTov
							),
							season: String(year),
							league: 'nba',
							synced: 0
						});
					}
				};

				processNBATeam(rawData.homeTeam);
				processNBATeam(rawData.awayTeam);
			} else {
				if (!Array.isArray(rawData.resultSets)) {
					continue;
				}

				const playerStatsSet = rawData.resultSets.find(s => s.name === 'PlayerStats');
				const teamStatsSet = rawData.resultSets.find(s => s.name === 'TeamStats');

				const rawPlayers = mapResultSet(playerStatsSet);
				const rawTeams = mapResultSet(teamStatsSet);

				// Transform Players
				for (const p of rawPlayers) {
					const gameId = String(p.GAME_ID || '').trim();
					const playerId = Number(p.PLAYER_ID || 0);

					if (!gameId || !playerId) continue;

					const pts = Number(p.PTS ?? 0);
					const fgm = Number(p.FGM ?? 0);
					const fga = Number(p.FGA ?? 0);
					const fg3m = Number(p.FG3M ?? 0);
					const fg3a = Number(p.FG3A ?? 0);
					const ftm = Number(p.FTM ?? 0);
					const fta = Number(p.FTA ?? 0);
					const oreb = Number(p.OREB ?? 0);
					const dreb = Number(p.DREB ?? 0);
					const stl = Number(p.STL ?? 0);
					const ast = Number(p.AST ?? 0);
					const blk = Number(p.BLK ?? 0);
					const pf = Number(p.PF ?? 0);
					const tov = Number(p.TO ?? p.TOV ?? p.TURNOVERS ?? 0); // Handle TO/TOV keyword variations safely

					allPlayers.push({
						game_id: gameId,
						player_id: playerId,
						player_name: p.PLAYER_NAME ? BaseNormalizer.cleanString(p.PLAYER_NAME) : '',
						normalized_name: p.PLAYER_NAME ? BaseNormalizer.normalizeName(p.PLAYER_NAME) : '',
						team_id: Number(p.TEAM_ID || 0),
						team_abbreviation: p.TEAM_ABBREVIATION ? BaseNormalizer.cleanString(p.TEAM_ABBREVIATION) : '',
						team_city: p.TEAM_CITY ? BaseNormalizer.cleanString(p.TEAM_CITY) : '',
						start_position: p.START_POSITION ? BaseNormalizer.cleanString(p.START_POSITION) : '',
						comment: p.COMMENT ? BaseNormalizer.cleanString(p.COMMENT) : '',
						min: p.MIN ? String(p.MIN).trim() : null,
						fgm,
						fga,
						fg_pct: Number(p.FG_PCT ?? 0.0),
						fg3m,
						fg3a,
						fg3_pct: Number(p.FG3_PCT ?? 0.0),
						ftm,
						fta,
						ft_pct: Number(p.FT_PCT ?? 0.0),
						oreb,
						dreb,
						reb: Number(p.REB ?? 0),
						ast,
						stl,
						blk,
						tov,
						pf,
						pts,
						plus_minus: Number(p.PLUS_MINUS ?? 0.0),
						ts_pct: BaseNormalizer.calculateTSPct(pts, fga, fta),
						efg_pct: BaseNormalizer.calculateEFGPct(fgm, fg3m, fga),
						game_score: BaseNormalizer.calculateGameScore(
							pts, fgm, fga, fta, ftm, oreb, dreb, stl, ast, blk, pf, tov
						),
						season: String(year),
						league: String(league),
						synced: 0
					});
				}

				// Transform Teams
				for (const t of rawTeams) {
					const gameId = String(t.GAME_ID || '').trim();
					const teamId = Number(t.TEAM_ID || 0);

					if (!gameId || !teamId) continue;

					const pts = Number(t.PTS ?? 0);
					const fgm = Number(t.FGM ?? 0);
					const fga = Number(t.FGA ?? 0);
					const fg3m = Number(t.FG3M ?? 0);
					const fg3a = Number(t.FG3A ?? 0);
					const ftm = Number(t.FTM ?? 0);
					const fta = Number(t.FTA ?? 0);
					const oreb = Number(t.OREB ?? 0);
					const dreb = Number(t.DREB ?? 0);
					const stl = Number(t.STL ?? 0);
					const ast = Number(t.AST ?? 0);
					const blk = Number(t.BLK ?? 0);
					const pf = Number(t.PF ?? 0);
					const tov = Number(t.TO ?? t.TOV ?? t.TURNOVERS ?? 0);

					allTeams.push({
						game_id: gameId,
						team_id: teamId,
						team_name: t.TEAM_NAME ? BaseNormalizer.cleanString(t.TEAM_NAME) : '',
						team_abbreviation: t.TEAM_ABBREVIATION ? BaseNormalizer.cleanString(t.TEAM_ABBREVIATION) : '',
						team_city: t.TEAM_CITY ? BaseNormalizer.cleanString(t.TEAM_CITY) : '',
						min: t.MIN ? String(t.MIN).trim() : null,
						fgm,
						fga,
						fg_pct: Number(t.FG_PCT ?? 0.0),
						fg3m,
						fg3a,
						fg3_pct: Number(t.FG3_PCT ?? 0.0),
						ftm,
						fta,
						ft_pct: Number(t.FT_PCT ?? 0.0),
						oreb,
						dreb,
						reb: Number(t.REB ?? 0),
						ast,
						stl,
						blk,
						tov,
						pf,
						pts,
						plus_minus: Number(t.PLUS_MINUS ?? 0.0),
						ts_pct: BaseNormalizer.calculateTSPct(pts, fga, fta),
						efg_pct: BaseNormalizer.calculateEFGPct(fgm, fg3m, fga),
						season: String(year),
						league: String(league),
						synced: 0
					});
				}
			}
		} catch (error) {
			console.error(`❌ Failed to transform file ${filePath}:`, error);
			throw error;
		}
	}

	const result = { players: allPlayers, teams: allTeams };

	// Cache the transformed data to disk
	const cacheDir = path.resolve('data/transformed', league, String(year));
	await fs.mkdir(cacheDir, { recursive: true });
	const cachePath = path.join(cacheDir, 'transformed.json');
	await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8');

	console.log(`💾 Transformed output cached to ${cachePath}`);
	console.log(`✅ Stage 2 [TRANSFORM] complete. Produced ${allPlayers.length} player rows and ${allTeams.length} team rows.\n`);

	return result;
}
