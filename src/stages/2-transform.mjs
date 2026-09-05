import fs from 'fs/promises';
import path from 'path';
import { BaseNormalizer } from '#utils';
import { transformEurope } from '../scrapers/europe/europe_transform.mjs';

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
export async function transformStage(league, year, options = {}) {
	const isPbp = options.boxscoreType === 'pbp' || options.type === 'pbp';
	console.log(`⚙️ Starting Stage 2 [TRANSFORM] for ${league.toUpperCase()} - ${year}${isPbp ? ' (PBP)' : ''}`);

	let rawDir = path.resolve('data/raw', league, String(year));

	if (isPbp) {
		const jsonFilesMap = [];
		if (league.toLowerCase().startsWith('europe')) {
			const subFolders = ['euroleague', 'eurocup', 'bcl', 'acb', 'lnb'];
			for (const sf of subFolders) {
				const sfDir = path.resolve('data/raw', league.includes('_test') ? league : 'europe', 'pbp', sf, String(year));
				try {
					const sfFiles = await fs.readdir(sfDir);
					for (const f of sfFiles.filter(file => file.endsWith('.json'))) {
						jsonFilesMap.push({ dir: sfDir, fileName: f });
					}
				} catch (e) {
					// Subfolder doesn't exist
				}
			}
		} else {
			const dir = path.resolve('data/raw', league, 'pbp', String(year));
			try {
				const files = await fs.readdir(dir);
				for (const f of files.filter(file => file.endsWith('.json'))) {
					jsonFilesMap.push({ dir, fileName: f });
				}
			} catch (e) {
				// Directory doesn't exist
			}
		}

		if (jsonFilesMap.length === 0) {
			console.warn(`⚠️ Raw PBP data directory does not exist or contains no JSON files.`);
			console.warn(`💡 Hint: Ensure you have executed Stage 1 [EXTRACT] first (e.g., node run.js --league=${league} --years=${year} --type=pbp --step=extract,transform,load)`);
			return { events: [], stints: [] };
		} else {
			console.log(`📂 Found ${jsonFilesMap.length} raw PBP JSON files to transform.`);
		}

		const allEvents = [];
		const allStints = [];

		let transformFn;
		if (league.toLowerCase().startsWith('wnba')) {
			const { transformWnbaPbp } = await import('../scrapers/wnba/pbp/WnbaPbpTransformer.mjs');
			transformFn = transformWnbaPbp;
		} else if (league.toLowerCase().startsWith('nba')) {
			const { transformNbaPbp } = await import('../scrapers/nba/pbp/NbaPbpTransformer.mjs');
			transformFn = transformNbaPbp;
		} else if (league.toLowerCase().startsWith('nbl')) {
			const { transformNblPbp } = await import('../scrapers/nbl/pbp/NblPbpTransformer.mjs');
			transformFn = transformNblPbp;
		} else if (league.toLowerCase().startsWith('europe')) {
			const { transformEuroleaguePbp } = await import('../scrapers/europe/pbp/EuroleaguePbpTransformer.mjs');
			const { transformAcbPbp } = await import('../scrapers/europe/pbp/AcbPbpTransformer.mjs');
			const { transformLnbPbp } = await import('../scrapers/europe/pbp/LnbPbpTransformer.mjs');

			transformFn = (gameId, rawData) => {
				const clean = String(gameId || '').trim();
				const isAcb = clean.startsWith('A') || clean.includes('_acb_') || (rawData && rawData.competitionId && String(rawData.competitionId).toLowerCase().includes('acb'));
				if (isAcb) {
					return transformAcbPbp(gameId, rawData);
				}
				const isLnb = clean.startsWith('L') || clean.includes('_lnb_') || (rawData && rawData.competitionId && String(rawData.competitionId).toLowerCase().includes('lnb'));
				if (isLnb) {
					return transformLnbPbp(gameId, rawData);
				}
				return transformEuroleaguePbp(gameId, rawData);
			};
		} else {
			throw new Error(`PBP transformation not implemented for league: ${league}`);
		}

		for (const { dir, fileName } of jsonFilesMap) {
			const filePath = path.join(dir, fileName);
			try {
				const content = await fs.readFile(filePath, 'utf8');
				const rawData = JSON.parse(content);
				if (!rawData) continue;
				const gameId = fileName.replace('.json', '');
				const result = transformFn(gameId, rawData);
				if (result && Array.isArray(result.events)) {
					allEvents.push(...result.events);
				}
				if (result && Array.isArray(result.stints)) {
					allStints.push(...result.stints);
				}
			} catch (err) {
				console.error(`❌ Failed to transform PBP file ${filePath}:`, err);
				throw err;
			}
		}

		const pbpResult = { events: allEvents, stints: allStints };
		const cacheDir = path.resolve('data/transformed', league, 'pbp', String(year));
		await fs.mkdir(cacheDir, { recursive: true });
		const cachePath = path.join(cacheDir, 'transformed.json');
		await fs.writeFile(cachePath, JSON.stringify(pbpResult, null, 2), 'utf8');

		console.log(`💾 Transformed PBP output cached to ${cachePath}`);
		console.log(`✅ Stage 2 [TRANSFORM] complete. Produced ${allEvents.length} event rows and ${allStints.length} stint rows.\n`);

		return pbpResult;
	}

	if (league.toLowerCase().startsWith('europe')) {
		const result = await transformEurope(rawDir, year);

		// Apply supplemental overrides if present
		try {
			const overridesPath = path.resolve('config', `${league}_overrides.json`);
			const overridesContent = await fs.readFile(overridesPath, 'utf8');
			const overrides = JSON.parse(overridesContent);
			console.log(`🔧 Applying game score overrides from ${overridesPath}...`);
			for (const team of result.teams) {
				const gameOverride = overrides[team.game_id];
				if (gameOverride && gameOverride[team.team_id] !== undefined) {
					team.pts = Number(gameOverride[team.team_id]);
				}
			}
		} catch (e) {
			// Ignore if not present
		}

		// Cache the transformed data to disk
		const cacheDir = path.resolve('data/transformed', league, String(year));
		await fs.mkdir(cacheDir, { recursive: true });
		const cachePath = path.join(cacheDir, 'transformed.json');
		await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8');

		console.log(`💾 Transformed output cached to ${cachePath}`);
		console.log(`✅ Stage 2 [TRANSFORM] complete. Produced ${result.players.length} player rows, ${result.teams.length} team rows, and referential mappings.\n`);

		return result;
	}

	let files = [];
	try {
		files = await fs.readdir(rawDir);
	} catch (error) {
		console.warn(`⚠️ Raw data directory does not exist or cannot be read: ${rawDir}`);
		console.warn(`💡 Hint: Ensure you have executed Stage 1 [EXTRACT] first (e.g., node run.js --league=${league} --years=${year} --step=extract,transform,load)`);
		return { players: [], teams: [] };
	}

	const jsonFiles = files.filter(f => f.endsWith('.json'));
	console.log(`📂 Found ${jsonFiles.length} raw JSON files to transform.`);

	const allPlayers = [];
	const allTeams = [];

	// Load Mexico team mappings config once outside the loop
	let mexicoMappings = {};
	if (league.toLowerCase() === 'mexico' || league.toLowerCase().startsWith('mexico')) {
		try {
			const mappingPath = path.resolve('config/mexico_team_mappings.json');
			const mappingContent = await fs.readFile(mappingPath, 'utf8');
			const parsed = JSON.parse(mappingContent);
			for (const [k, v] of Object.entries(parsed)) {
				mexicoMappings[k.toUpperCase().trim()] = v;
			}
		} catch (e) {
			console.warn('⚠️ Could not load Mexico team mappings:', e.message);
		}
	}

	// Load Canada team mappings config once outside the loop
	let canadaMappings = {};
	if (league.toLowerCase() === 'canada' || league.toLowerCase().startsWith('canada')) {
		try {
			const mappingPath = path.resolve('config/canada_team_mappings.json');
			const mappingContent = await fs.readFile(mappingPath, 'utf8');
			const parsed = JSON.parse(mappingContent);
			for (const [k, v] of Object.entries(parsed)) {
				canadaMappings[k.toUpperCase().trim()] = v;
			}
		} catch (e) {
			console.warn('⚠️ Could not load Canada team mappings:', e.message);
		}
	}

	// Load Puerto Rico team mappings config once outside the loop
	let puertoricoMappings = {};
	if (league.toLowerCase() === 'puertorico' || league.toLowerCase().startsWith('puertorico')) {
		try {
			const mappingPath = path.resolve('config/puertorico_team_mappings.json');
			const mappingContent = await fs.readFile(mappingPath, 'utf8');
			const parsed = JSON.parse(mappingContent);
			for (const [k, v] of Object.entries(parsed)) {
				puertoricoMappings[k.toUpperCase().trim()] = v;
			}
		} catch (e) {
			console.warn('⚠️ Could not load Puerto Rico team mappings:', e.message);
		}
	}

	// Load South America team mappings config once outside the loop
	let southamericaMappings = {};
	if (league.toLowerCase() === 'southamerica' || league.toLowerCase().startsWith('southamerica')) {
		try {
			const mappingPath = path.resolve('config/southamerica_team_mappings.json');
			const mappingContent = await fs.readFile(mappingPath, 'utf8');
			const parsed = JSON.parse(mappingContent);
			for (const [k, v] of Object.entries(parsed)) {
				southamericaMappings[k.toUpperCase().trim()] = v;
			}
		} catch (e) {
			console.warn('⚠️ Could not load South America team mappings:', e.message);
		}
	}

	// Load NBL team mappings config once outside the loop
	let nblMappings = {};
	if (league.toLowerCase() === 'nbl' || league.toLowerCase().startsWith('nbl')) {
		try {
			const mappingPath = path.resolve('config/nbl_team_mappings.json');
			const mappingContent = await fs.readFile(mappingPath, 'utf8');
			const parsed = JSON.parse(mappingContent);
			for (const [k, v] of Object.entries(parsed)) {
				nblMappings[k.toUpperCase().trim()] = v;
			}
		} catch (e) {
			console.warn('⚠️ Could not load NBL team mappings:', e.message);
		}
	}

	// Load Asia team mappings config once outside the loop
	let asiaMappings = {};
	if (league.toLowerCase() === 'asia' || league.toLowerCase().startsWith('asia')) {
		try {
			const mappingPath = path.resolve('config/asia_team_mappings.json');
			const mappingContent = await fs.readFile(mappingPath, 'utf8');
			const parsed = JSON.parse(mappingContent);
			for (const [k, v] of Object.entries(parsed)) {
				asiaMappings[k.toUpperCase().trim()] = v;
			}
		} catch (e) {
			console.warn('⚠️ Could not load Asia team mappings:', e.message);
		}
	}

	for (const fileName of jsonFiles) {
		const filePath = path.join(rawDir, fileName);
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const rawData = JSON.parse(content);

			if (!rawData) {
				continue;
			}

			if (BaseNormalizer.isGameUnplayed(rawData, league)) {
				console.log(`⏭️ [Transform] Skipping unplayed/future game: ${fileName}`);
				continue;
			}

			if (league.toLowerCase() === 'mexico' || league.toLowerCase().startsWith('mexico')) {
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const resolveMexicoTeam = (rawName) => {
					const clean = BaseNormalizer.cleanString(rawName);
					const upper = clean.toUpperCase();
					if (mexicoMappings[upper]) {
						return mexicoMappings[upper];
					}
					return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
				};

				const homeScore = Number(rawData.homeTeam?.score ?? 0);
				const awayScore = Number(rawData.awayTeam?.score ?? 0);

				const processMexicoTeam = (teamObj, isHome, otherScore) => {
					if (!teamObj) return;
					const rawTeamName = teamObj.teamName || '';
					const canonicalTeamId = resolveMexicoTeam(rawTeamName);

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
						league: 'mexico',
						synced: 0
					});

					for (const p of players) {
						const pStats = p.statistics || {};
						const rawPlayerName = p.playerName || '';
						const pPts = Number(pStats.pts ?? 0);
						const pFgm = Number(pStats.fgm ?? 0);
						const pFga = Number(pStats.fga ?? 0);
						const pFg3m = Number(pStats.fg3m ?? 0);
						const pFg3a = Number(pStats.threePointersAttempted ?? pStats.fg3a ?? 0);
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
							player_id: p.playerId || BaseNormalizer.normalizeName(rawPlayerName).toLowerCase().replace(/\s+/g, '-'),
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
							league: 'mexico',
							synced: 0
						});
					}
				};

				processMexicoTeam(rawData.homeTeam, true, awayScore);
				processMexicoTeam(rawData.awayTeam, false, homeScore);
			} else if (league.toLowerCase() === 'canada' || league.toLowerCase().startsWith('canada')) {
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const resolveCanadaTeam = (rawName) => {
					const clean = BaseNormalizer.cleanString(rawName);
					const upper = clean.toUpperCase();
					if (canadaMappings[upper]) {
						return canadaMappings[upper];
					}
					return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
				};

				const homeScore = Number(rawData.homeTeam?.score ?? 0);
				const awayScore = Number(rawData.awayTeam?.score ?? 0);

				const processCanadaTeam = (teamObj, isHome, otherScore) => {
					if (!teamObj) return;
					const rawTeamName = teamObj.teamName || '';
					const canonicalTeamId = resolveCanadaTeam(rawTeamName);

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
						plus_minus: isHome ? (pts - otherScore) : (pts - otherScore),
						ts_pct: BaseNormalizer.calculateTSPct(pts, fga, fta),
						efg_pct: BaseNormalizer.calculateEFGPct(fgm, fg3m, fga),
						season: String(year),
						league: 'canada',
						synced: 0
					});

					for (const p of players) {
						const pStats = p.statistics || {};
						const rawPlayerName = p.playerName || '';
						const pPts = Number(pStats.pts ?? 0);
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
							player_id: p.playerId || BaseNormalizer.normalizeName(rawPlayerName).toLowerCase().replace(/\s+/g, '-'),
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
							league: 'canada',
							synced: 0
						});
					}
				};

				processCanadaTeam(rawData.homeTeam, true, awayScore);
				processCanadaTeam(rawData.awayTeam, false, homeScore);
			} else if (league.toLowerCase() === 'puertorico' || league.toLowerCase().startsWith('puertorico')) {
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const resolvePuertoRicoTeam = (rawName) => {
					const clean = BaseNormalizer.cleanString(rawName);
					const upper = clean.toUpperCase();
					if (puertoricoMappings[upper]) {
						return puertoricoMappings[upper];
					}
					return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
				};

				const homeScore = Number(rawData.homeTeam?.score ?? 0);
				const awayScore = Number(rawData.awayTeam?.score ?? 0);

				const processPuertoRicoTeam = (teamObj, isHome, otherScore) => {
					if (!teamObj) return;
					const rawTeamName = teamObj.teamName || '';
					const canonicalTeamId = resolvePuertoRicoTeam(rawTeamName);

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
						league: 'puertorico',
						synced: 0
					});

					for (const p of players) {
						const pStats = p.statistics || {};
						const rawPlayerName = p.playerName || '';
						const pPts = Number(pStats.pts ?? 0);
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
							player_id: p.playerId || BaseNormalizer.normalizeName(rawPlayerName).toLowerCase().replace(/\s+/g, '-'),
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
							league: 'puertorico',
							synced: 0
						});
					}
				};

				processPuertoRicoTeam(rawData.homeTeam, true, awayScore);
				processPuertoRicoTeam(rawData.awayTeam, false, homeScore);
			} else if (league.toLowerCase() === 'southamerica' || league.toLowerCase().startsWith('southamerica')) {
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const resolveSouthAmericaTeam = (rawName) => {
					const clean = BaseNormalizer.cleanString(rawName);
					const upper = clean.toUpperCase();
					if (southamericaMappings[upper]) {
						return southamericaMappings[upper];
					}
					return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
				};

				const homeScore = Number(rawData.homeTeam?.score ?? 0);
				const awayScore = Number(rawData.awayTeam?.score ?? 0);

				const processSouthAmericaTeam = (teamObj, isHome, otherScore) => {
					if (!teamObj) return;
					const rawTeamName = teamObj.teamName || '';
					const canonicalTeamId = resolveSouthAmericaTeam(rawTeamName);

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
						league: 'southamerica',
						synced: 0
					});

					for (const p of players) {
						const pStats = p.statistics || {};
						const rawPlayerName = p.playerName || '';
						const pPts = Number(pStats.pts ?? 0);
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
							player_id: p.playerId || BaseNormalizer.normalizeName(rawPlayerName).toLowerCase().replace(/\s+/g, '-'),
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
							league: 'southamerica',
							synced: 0
						});
					}
				};

				processSouthAmericaTeam(rawData.homeTeam, true, awayScore);
				processSouthAmericaTeam(rawData.awayTeam, false, homeScore);
			} else if (league.toLowerCase() === 'asia' || league.toLowerCase().startsWith('asia')) {
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const resolveAsiaTeam = (rawName) => {
					const clean = BaseNormalizer.cleanString(rawName);
					const upper = clean.toUpperCase();
					if (asiaMappings[upper]) {
						return asiaMappings[upper];
					}
					return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
				};

				const homeScore = Number(rawData.homeTeam?.score ?? 0);
				const awayScore = Number(rawData.awayTeam?.score ?? 0);

				const processAsiaTeam = (teamObj, isHome, otherScore) => {
					if (!teamObj) return;
					const rawTeamName = teamObj.teamName || '';
					const canonicalTeamId = resolveAsiaTeam(rawTeamName);

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
						league: 'asia',
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
							league: 'asia',
							synced: 0
						});
					}

					// Points Reconciliation: Check for variance between team total score and player point sums
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
							league: 'asia',
							synced: 0
						});
					}
				};

				processAsiaTeam(rawData.homeTeam, true, awayScore);
				processAsiaTeam(rawData.awayTeam, false, homeScore);
			} else if (league.toLowerCase() === 'nbl' || league.toLowerCase().startsWith('nbl')) {
				const gameId = String(rawData.gameId || '').trim();
				if (!gameId) continue;

				const resolveNblTeam = (rawName) => {
					const clean = BaseNormalizer.cleanString(rawName);
					const upper = clean.toUpperCase();
					if (nblMappings[upper]) {
						return nblMappings[upper];
					}
					return clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
				};

				const homeScore = Number(rawData.homeTeam?.score ?? 0);
				const awayScore = Number(rawData.awayTeam?.score ?? 0);

				const processNblTeam = (teamObj, isHome, otherScore) => {
					if (!teamObj) return;
					const rawTeamName = teamObj.teamName || '';
					const canonicalTeamId = resolveNblTeam(rawTeamName);

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
						league: 'nbl',
						synced: 0
					});

					for (const p of players) {
						const pStats = p.statistics || {};
						const rawPlayerName = p.playerName || '';
						const pPts = Number(pStats.pts ?? 0);
						const pFgm = Number(pStats.fgm ?? 0);
						const pFga = Number(pStats.fga ?? 0);
						const pFg3m = Number(pStats.fg3m ?? 0);
						const pFg3a = Number(pStats.fg3a ?? pStats.threePointersAttempted ?? 0);
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
							player_id: p.playerId || BaseNormalizer.normalizeName(rawPlayerName).toLowerCase().replace(/\s+/g, '-'),
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
							league: 'nbl',
							synced: 0
						});
					}
				};

				processNblTeam(rawData.homeTeam, true, awayScore);
				processNblTeam(rawData.awayTeam, false, homeScore);
			} else if (league.toLowerCase() === 'nba') {
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

					// Deduplicate players with identical personIds by keeping the entry with played minutes
					const playersMap = new Map();
					for (const p of players) {
						const playerId = Number(p.personId || 0);
						if (!playerId) continue;

						if (!playersMap.has(playerId)) {
							playersMap.set(playerId, []);
						}
						playersMap.get(playerId).push(p);
					}

					const deduplicatedPlayers = [];
					for (const [playerId, group] of playersMap.entries()) {
						if (group.length === 1) {
							deduplicatedPlayers.push(group[0]);
						} else {
							// Find the first one with non-empty minutes
							const played = group.find(p => p.statistics?.minutes && p.statistics.minutes !== "");
							if (played) {
								deduplicatedPlayers.push(played);
							} else {
								// Fallback to the first one
								deduplicatedPlayers.push(group[0]);
							}
						}
					}

					for (const p of deduplicatedPlayers) {
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

	// Apply generic system game score overrides if present
	try {
		const overridesPath = path.resolve('config', `${league}_overrides.json`);
		const overridesContent = await fs.readFile(overridesPath, 'utf8');
		const overrides = JSON.parse(overridesContent);
		console.log(`🔧 Applying game score overrides from ${overridesPath}...`);
		for (const team of result.teams) {
			const gameOverride = overrides[team.game_id];
			if (gameOverride && gameOverride[team.team_id] !== undefined) {
				console.log(`🔧 Overriding team ${team.team_id} score in game ${team.game_id} to ${gameOverride[team.team_id]}`);
				team.pts = Number(gameOverride[team.team_id]);
			}
		}
	} catch (e) {
		// Ignore if file doesn't exist or is unparseable
	}

	// Cache the transformed data to disk
	const cacheDir = path.resolve('data/transformed', league, String(year));
	await fs.mkdir(cacheDir, { recursive: true });
	const cachePath = path.join(cacheDir, 'transformed.json');
	await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8');

	console.log(`💾 Transformed output cached to ${cachePath}`);
	console.log(`✅ Stage 2 [TRANSFORM] complete. Produced ${allPlayers.length} player rows and ${allTeams.length} team rows.\n`);

	return result;
}
