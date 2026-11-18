import fs from 'fs/promises';
import path from 'path';
import { BaseNormalizer } from '#utils';

/**
 * @description Canonical B.League team slug mapping, keyed by upper-cased team name.
 * Loaded from `config/bleague_team_mappings.json`.
 * @typedef {Record<string, string>} BLeagueTeamMappings
 */

/**
 * @description Flat database-ready arrays produced from raw B.League box scores.
 * @typedef {Object} BLeagueTransformResult
 * @property {Record<string, any>[]} players - Flat `player_game_stats` rows (incl. Team/Bench reconciliation rows)
 * @property {Record<string, any>[]} teams - Flat `team_game_stats` rows
 */

/**
 * @description Loads the B.League canonical team slug mappings from
 * `config/bleague_team_mappings.json`, keyed by upper-cased team name.
 * @returns {Promise<BLeagueTeamMappings>} Mapping of upper-cased team names to canonical slugs
 * @throws {Error} If the mapping file cannot be read or parsed
 */
export async function loadBLeagueMappings() {
	const mappingPath = path.resolve('config/bleague_team_mappings.json');
	const mappingContent = await fs.readFile(mappingPath, 'utf8');
	const parsed = JSON.parse(mappingContent);
	/** @type {BLeagueTeamMappings} */
	const mappings = {};
	for (const [key, value] of Object.entries(parsed)) {
		mappings[key.toUpperCase().trim()] = value;
	}
	return mappings;
}

/**
 * @description Resolves a raw B.League team name to its canonical slug using the
 * configured mappings, falling back to a generic slugifier for unknown teams.
 * @param {string} rawName - Raw team name from the payload (e.g. `SEAHORSES MIKAWA`)
 * @param {BLeagueTeamMappings} mappings - Upper-cased team name to slug mapping
 * @returns {string} Canonical team slug (e.g. `seahorses-mikawa`)
 */
function resolveBLeagueTeam(rawName, mappings) {
	const clean = BaseNormalizer.cleanString(rawName);
	const upper = clean.toUpperCase();
	if (mappings[upper]) {
		return mappings[upper];
	}
	return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

/**
 * @description Transforms raw B.League box score JSON payloads (unified shape produced by
 * `BLeagueScraper.request`) into clean, database-ready flat rows.
 *
 * Team totals stay authoritative: whenever the official team score differs from the sum of
 * player points, the variance is emitted as a `Team/Bench` reconciliation row so box scores
 * remain internally consistent without mutating official statistics.
 *
 * @param {string} rawDir - Directory containing the raw unified box score JSON files
 * @param {string|number} year - The season start year (e.g. `2024`)
 * @returns {Promise<BLeagueTransformResult>} Mapped collection containing player and team rows
 * @throws {Error} If reading or transforming a raw file fails
 */
export async function transformBLeague(rawDir, year) {
	let files = [];
	try {
		files = await fs.readdir(rawDir);
	} catch (error) {
		console.warn(`⚠️ Raw B.League directory does not exist: ${rawDir}`);
		return { players: [], teams: [] };
	}

	// Side-cache subdirectories (e.g. `payloads/`) never end in `.json`, so the flat
	// scan below only ever picks up unified game files.
	const jsonFiles = files.filter(f => f.endsWith('.json'));
	console.log(`📂 Found ${jsonFiles.length} raw JSON files to transform.`);

	/** @type {BLeagueTeamMappings} */
	let mappings = {};
	try {
		mappings = await loadBLeagueMappings();
	} catch (error) {
		console.warn('⚠️ Could not load B.League team mappings:', error.message);
	}

	/** @type {Record<string, any>[]} */
	const allPlayers = [];
	/** @type {Record<string, any>[]} */
	const allTeams = [];

	for (const fileName of jsonFiles) {
		const filePath = path.join(rawDir, fileName);
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const rawData = JSON.parse(content);

			if (!rawData) {
				continue;
			}

			if (BaseNormalizer.isGameUnplayed(rawData, 'bleague')) {
				console.log(`⏭️ [Transform] Skipping unplayed/future game: ${fileName}`);
				continue;
			}

			const gameId = String(rawData.gameId || '').trim();
			if (!gameId) continue;

			const homeScore = Number(rawData.homeTeam?.score ?? 0);
			const awayScore = Number(rawData.awayTeam?.score ?? 0);

			const processBLeagueTeam = (teamObj, otherScore) => {
				if (!teamObj) return;
				const rawTeamName = teamObj.teamName || '';
				const canonicalTeamId = resolveBLeagueTeam(rawTeamName, mappings);

				const players = teamObj.players || [];
				let fgm = 0, fga = 0, fg3m = 0, fg3a = 0, ftm = 0, fta = 0;
				let oreb = 0, dreb = 0, reb = 0, ast = 0, stl = 0, blk = 0, tov = 0, pf = 0;
				const pts = teamObj.score || 0;

				for (const p of players) {
					const pStats = p.statistics || {};
					fgm += Number(pStats.fgm ?? 0);
					fga += Number(pStats.fga ?? 0);
					fg3m += Number(pStats.fg3m ?? 0);
					fg3a += Number(pStats.fg3a ?? 0);
					ftm += Number(pStats.ftm ?? 0);
					fta += Number(pStats.fta ?? 0);
					oreb += Number(pStats.oreb ?? 0);
					dreb += Number(pStats.dreb ?? 0);
					reb += Number(pStats.reb ?? 0);
					ast += Number(pStats.ast ?? 0);
					stl += Number(pStats.stl ?? 0);
					blk += Number(pStats.blk ?? 0);
					tov += Number(pStats.tov ?? 0);
					pf += Number(pStats.pf ?? 0);
				}

				allTeams.push({
					game_id: gameId,
					team_id: canonicalTeamId,
					team_name: BaseNormalizer.cleanString(rawTeamName),
					team_abbreviation: teamObj.teamId || canonicalTeamId.substring(0, 4).toUpperCase(),
					team_city: BaseNormalizer.cleanString(rawTeamName).split(' ')[0] || '',
					min: '200:00',
					fgm,
					fga,
					fg_pct: fga > 0 ? Number((fgm / fga).toFixed(3)) : 0.0,
					fg3m,
					fg3a,
					fg3_pct: fg3a > 0 ? Number((fg3m / fg3a).toFixed(3)) : 0.0,
					ftm,
					fta,
					ft_pct: fta > 0 ? Number((ftm / fta).toFixed(3)) : 0.0,
					oreb,
					dreb,
					reb,
					ast,
					stl,
					blk,
					tov,
					pf,
					pts,
					plus_minus: pts - otherScore,
					ts_pct: BaseNormalizer.calculateTSPct(pts, fga, fta),
					efg_pct: BaseNormalizer.calculateEFGPct(fgm, fg3m, fga),
					season: String(year),
					league: 'bleague',
					synced: 0
				});

				let playerPtsSum = 0;
				const seenPlayerIds = new Map();
				for (const p of players) {
					const pStats = p.statistics || {};
					const rawPlayerName = p.playerName || '';
					const pPts = Number(pStats.pts ?? 0);
					playerPtsSum += pPts;

					let basePlayerId = p.playerId || BaseNormalizer.normalizeName(rawPlayerName).toLowerCase().replace(/\s+/g, '-');
					if (!basePlayerId) basePlayerId = 'unknown-player';

					let finalPlayerId = basePlayerId;
					const count = seenPlayerIds.get(basePlayerId) || 0;
					if (count > 0) {
						finalPlayerId = `${basePlayerId}-${count + 1}`;
					}
					seenPlayerIds.set(basePlayerId, count + 1);

					const pFgm = Number(pStats.fgm ?? 0);
					const pFga = Number(pStats.fga ?? 0);
					const pFg3m = Number(pStats.fg3m ?? 0);
					const pFg3a = Number(pStats.fg3a ?? 0);
					const pFtm = Number(pStats.ftm ?? 0);
					const pFta = Number(pStats.fta ?? 0);
					const pOreb = Number(pStats.oreb ?? 0);
					const pDreb = Number(pStats.dreb ?? 0);
					const pReb = Number(pStats.reb ?? 0);
					const pAst = Number(pStats.ast ?? 0);
					const pStl = Number(pStats.stl ?? 0);
					const pBlk = Number(pStats.blk ?? 0);
					const pTov = Number(pStats.tov ?? 0);
					const pPf = Number(pStats.pf ?? 0);

					allPlayers.push({
						game_id: gameId,
						player_id: finalPlayerId,
						player_name: BaseNormalizer.cleanString(rawPlayerName),
						normalized_name: BaseNormalizer.normalizeName(rawPlayerName),
						team_id: canonicalTeamId,
						team_abbreviation: teamObj.teamId || canonicalTeamId.substring(0, 4).toUpperCase(),
						team_city: BaseNormalizer.cleanString(rawTeamName).split(' ')[0] || '',
						start_position: '',
						comment: '',
						min: pStats.min ? String(BaseNormalizer.parseMinutesToFloat(pStats.min)) : null,
						fgm: pFgm,
						fga: pFga,
						fg_pct: pFga > 0 ? Number((pFgm / pFga).toFixed(3)) : 0.0,
						fg3m: pFg3m,
						fg3a: pFg3a,
						fg3_pct: pFg3a > 0 ? Number((pFg3m / pFg3a).toFixed(3)) : 0.0,
						ftm: pFtm,
						fta: pFta,
						ft_pct: pFta > 0 ? Number((pFtm / pFta).toFixed(3)) : 0.0,
						oreb: pOreb,
						dreb: pDreb,
						reb: pReb,
						ast: pAst,
						stl: pStl,
						blk: pBlk,
						tov: pTov,
						pf: pPf,
						pts: pPts,
						plus_minus: Number(pStats.plus_minus ?? 0.0),
						ts_pct: BaseNormalizer.calculateTSPct(pPts, pFga, pFta),
						efg_pct: BaseNormalizer.calculateEFGPct(pFgm, pFg3m, pFga),
						game_score: BaseNormalizer.calculateGameScore(
							pPts, pFgm, pFga, pFta, pFtm, pOreb, pDreb, pStl, pAst, pBlk, pPf, pTov
						),
						season: String(year),
						league: 'bleague',
						synced: 0
					});
				}

				// Points Reconciliation: Check for variance between team total score and player point sums.
				// B.League box scores occasionally carry shot-chart inconsistencies, so the official
				// team score stays authoritative and the difference lands on a Team/Bench row.
				const variance = pts - playerPtsSum;
				if (variance !== 0 && pts > 0) {
					allPlayers.push({
						game_id: gameId,
						player_id: `${canonicalTeamId}_team`,
						player_name: 'Team/Bench',
						normalized_name: 'Team/Bench',
						team_id: canonicalTeamId,
						team_abbreviation: teamObj.teamId || canonicalTeamId.substring(0, 4).toUpperCase(),
						team_city: BaseNormalizer.cleanString(rawTeamName).split(' ')[0] || '',
						start_position: '',
						comment: 'Points Variance Reconciliation',
						min: '0.0',
						fgm: 0,
						fga: 0,
						fg_pct: 0.0,
						fg3m: 0,
						fg3a: 0,
						fg3_pct: 0.0,
						ftm: 0,
						fta: 0,
						ft_pct: 0.0,
						oreb: 0,
						dreb: 0,
						reb: 0,
						ast: 0,
						stl: 0,
						blk: 0,
						tov: 0,
						pf: 0,
						pts: variance,
						plus_minus: 0.0,
						ts_pct: 0.0,
						efg_pct: 0.0,
						game_score: variance,
						season: String(year),
						league: 'bleague',
						synced: 0
					});
				}
			};

			processBLeagueTeam(rawData.homeTeam, awayScore);
			processBLeagueTeam(rawData.awayTeam, homeScore);
		} catch (error) {
			console.error(`❌ Failed to transform B.League file ${filePath}:`, error);
			throw error;
		}
	}

	return { players: allPlayers, teams: allTeams };
}
