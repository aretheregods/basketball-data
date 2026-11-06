import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations-runner.mjs';
import { EUROPE_LEAGUE_REGISTRY, isEuropeanLeague, resolveLeagueForCompetition } from '../db/europe_league_registry.mjs';

/**
 * @description Initializes the SQLite connection for a specific league and ensures schema tables exist.
 * Saves the SQLite file to `data/SQL/<LEAGUE>.sqlite` (e.g., `data/SQL/WNBA.sqlite`).
 * For European leagues, the database file is determined by the league registry
 * (e.g., `data/SQL/euroleague.sqlite`, `data/SQL/acb.sqlite`).
 *
 * @param {string} [league='wnba'] - The lowercase league identifier (e.g., 'wnba', 'euroleague', 'acb')
 * @param {string} [europeLeagueId=''] - Optional European league ID for schema migrations
 * @returns {Promise<import('node:sqlite').DatabaseSync>} - The initialized DatabaseSync instance
 */
export async function initDatabase(league = 'wnba', europeLeagueId = '') {
	const dbDir = path.resolve('data/SQL');
	await fs.mkdir(dbDir, { recursive: true });

	// Determine database file name
	let dbFileName;
	if (europeLeagueId && isEuropeanLeague(europeLeagueId)) {
		const config = EUROPE_LEAGUE_REGISTRY[europeLeagueId];
		dbFileName = config.dbFile.replace('.sqlite', '').toUpperCase();
	} else {
		dbFileName = league.toUpperCase();
	}

	const dbPath = path.join(dbDir, `${dbFileName}.sqlite`);

	const db = new DatabaseSync(dbPath);

	// Run pending database migrations, passing leagueId for conditional schema creation
	await runMigrations(db, europeLeagueId || league);

	// Add destroy method as compatibility wrapper for test cleanups and syncStage
	db.destroy = () => {
		db.close();
	};

	return db;
}

/**
 * @description Runs the load stage: takes transformed objects (or loads from cache)
 * and batch inserts them to a local SQLite staging database inside a single transaction.
 * For European leagues, data is distributed across individual league databases
 * (e.g., euroleague.sqlite, acb.sqlite, gbl.sqlite) based on competition_id.
 *
 * @param {string} league - The lowercase league identifier (e.g., 'wnba')
 * @param {string|number} year - The season year (e.g., '2023')
 * @param {{ players?: Record<string, any>[], teams?: Record<string, any>[] }} [cleanedGamesArray] - Optional array of cleaned objects
 * @param {Object} [options] - Additional options
 * @param {string} [options.boxscoreType='traditional'] - Scraper configuration type
 * @param {string} [options.competitions='euroleague'] - Comma-separated list of target competitions
 * @returns {Promise<void>}
 * @throws {Error} - If database initialization or loading fails
 */
export async function loadStage(league, year, cleanedGamesArray, options = {}) {
	const isPbp = options.boxscoreType === 'pbp' || options.type === 'pbp';
	console.log(`📥 Starting Stage 3 [LOAD] for ${league.toUpperCase()} - ${year}${isPbp ? ' (PBP)' : ''}`);

	let data = cleanedGamesArray;
	let hasDirectData = false;

	if (isPbp) {
		if (data && (Array.isArray(data.events) || Array.isArray(data.stints))) {
			if ((data.events && data.events.length > 0) || (data.stints && data.stints.length > 0)) {
				hasDirectData = true;
			}
		}
		if (!hasDirectData) {
			const cachePath = path.resolve('data/transformed', league, 'pbp', String(year), 'transformed.json');
			try {
				console.log(`📂 No direct memory PBP data passed. Loading transformed PBP data from cache file: ${cachePath}`);
				const cacheContent = await fs.readFile(cachePath, 'utf8');
				data = JSON.parse(cacheContent);
			} catch (error) {
				console.error(`❌ Transformed PBP data cache file not found at ${cachePath}.`);
				throw new Error(`Failed to load PBP data for ${league.toUpperCase()} - ${year}. Raw data was not extracted or transformed yet. Please run Stage 1 [EXTRACT] first (e.g., node run.js --league=${league} --years=${year} --type=pbp --step=extract,transform,load).`);
			}
		}

		const events = (data && data.events) || [];
		const stints = (data && data.stints) || [];

		if (events.length === 0 && stints.length === 0) {
			const msg = `❌ No PBP event or stint records to load for ${league.toUpperCase()} - ${year}. Raw data was not extracted or transformed yet. Please run Stage 1 [EXTRACT] first (e.g., node run.js --league=${league} --years=${year} --type=pbp --step=extract,transform,load).`;
			console.error(msg);
			throw new Error(msg);
		}

		console.log(`💾 Connecting to SQLite local staging database [data/SQL/${league.toUpperCase()}.sqlite]...`);
		const db = await initDatabase(league);

		try {
			db.exec('BEGIN TRANSACTION');

			if (events.length > 0) {
				console.log(`📥 Inserting ${events.length} PBP event rows into 'game_play_by_play'...`);
				const keys = Object.keys(events[0]);
				const placeholders = keys.map(() => '?').join(', ');
				const insertStmt = db.prepare(`INSERT OR REPLACE INTO game_play_by_play (${keys.join(', ')}) VALUES (${placeholders})`);
				for (const event of events) {
					const values = keys.map(k => event[k] === undefined ? null : event[k]);
					insertStmt.run(...values);
				}
			}

			if (stints.length > 0) {
				console.log(`📥 Inserting ${stints.length} PBP stint rows into 'game_stints'...`);
				const keys = Object.keys(stints[0]);
				const placeholders = keys.map(() => '?').join(', ');
				const insertStmt = db.prepare(`INSERT OR REPLACE INTO game_stints (${keys.join(', ')}) VALUES (${placeholders})`);
				for (const stint of stints) {
					const values = keys.map(k => stint[k] === undefined ? null : stint[k]);
					insertStmt.run(...values);
				}
			}

			db.exec('COMMIT');
			console.log(`✅ Stage 3 [LOAD] complete. Successfully saved PBP records to local staging database.`);
		} catch (error) {
			db.exec('ROLLBACK');
			console.error(`❌ Database PBP TRANSACTION failure:`, error);
			throw error;
		} finally {
			db.close();
		}
		return;
	}

	if (data && (Array.isArray(data.players) || Array.isArray(data.teams))) {
		const playersCount = Array.isArray(data.players) ? data.players.length : 0;
		const teamsCount = Array.isArray(data.teams) ? data.teams.length : 0;
		if (playersCount > 0 || teamsCount > 0) {
			hasDirectData = true;
		}
	}

	// Load from cache if empty or not provided
	if (!hasDirectData) {
		const cachePath = path.resolve('data/transformed', league, String(year), 'transformed.json');
		try {
			console.log(`📂 No direct memory data passed. Loading transformed data from cache file: ${cachePath}`);
			const cacheContent = await fs.readFile(cachePath, 'utf8');
			data = JSON.parse(cacheContent);
		} catch (error) {
			console.error(`❌ Transformed data cache file not found at ${cachePath}.`);
			throw new Error(`Failed to load data for ${league.toUpperCase()} - ${year}. Raw data was not extracted or transformed yet. Please run Stage 1 [EXTRACT] first (e.g., node run.js --league=${league} --years=${year} --step=extract,transform,load).`);
		}
	}

	const players = (data && data.players) || [];
	const teams = (data && data.teams) || [];

	if (players.length === 0 && teams.length === 0) {
		const msg = `❌ No player or team records to load for ${league.toUpperCase()} - ${year}.`;
		console.error(msg);
		throw new Error(msg);
	}

	// ------------------------------------------------------------
	// EUROPE LEAGUE SPLIT LOGIC
	// ------------------------------------------------------------
	if (league.toLowerCase() === 'europe') {
		console.log(`🌍 Detected European league. Splitting data across per-league databases...`);

		// Collect all European data arrays from transformed output
		const europeData = {
			players: (data && data.players) || [],
			teams: (data && data.teams) || [],
			europe_competitions: (data && data.europe_competitions) || [],
			europe_teams: (data && data.europe_teams) || [],
			europe_team_aliases: (data && data.europe_team_aliases) || [],
			europe_players: (data && data.europe_players) || [],
			europe_games: (data && data.europe_games) || []
		};

		// Group data by competition_id, then map to league_id
		const dataByLeague = new Map();

		// Process each player - group by their league (competitionId)
		for (const player of europeData.players) {
			const compId = String(player.league || '').toLowerCase().trim();
			const leagueId = resolveLeagueForCompetition(compId);
			if (!leagueId) continue;
			if (!dataByLeague.has(leagueId)) {
				dataByLeague.set(leagueId, {
					players: [],
					teams: [],
					europe_competitions: [],
					europe_teams: [],
					europe_team_aliases: [],
					europe_players: [],
					europe_games: []
				});
			}
			dataByLeague.get(leagueId).players.push(player);
		}

		// Process each team - group by their league (league field)
		for (const team of europeData.teams) {
			const compId = String(team.league || '').toLowerCase().trim();
			const leagueId = resolveLeagueForCompetition(compId);
			if (!leagueId) continue;
			if (!dataByLeague.has(leagueId)) {
				dataByLeague.set(leagueId, {
					players: [],
					teams: [],
					europe_competitions: [],
					europe_teams: [],
					europe_team_aliases: [],
					europe_players: [],
					europe_games: []
				});
			}
			dataByLeague.get(leagueId).teams.push(team);
		}

		// Process europe_games - group by competition_id
		for (const game of europeData.europe_games) {
			const compId = String(game.competition_id || '').toLowerCase().trim();
			const leagueId = resolveLeagueForCompetition(compId);
			if (!leagueId) continue;

			if (!dataByLeague.has(leagueId)) {
				dataByLeague.set(leagueId, {
					players: [],
					teams: [],
					europe_competitions: [],
					europe_teams: [],
					europe_team_aliases: [],
					europe_players: [],
					europe_games: []
				});
			}
			const leagueBucket = dataByLeague.get(leagueId);
			leagueBucket.europe_games.push(game);
		}

		// Process europe_competitions - group by competition_id
		for (const comp of europeData.europe_competitions) {
			const compId = String(comp.id || '').toLowerCase().trim();
			const leagueId = resolveLeagueForCompetition(compId);
			if (!leagueId) continue;

			if (!dataByLeague.has(leagueId)) {
				dataByLeague.set(leagueId, {
					players: [],
					teams: [],
					europe_competitions: [],
					europe_teams: [],
					europe_team_aliases: [],
					europe_players: [],
					europe_games: []
				});
			}
			dataByLeague.get(leagueId).europe_competitions.push(comp);
		}

		// Process europe_teams - Ensure team is in EVERY league they play in
		for (const team of europeData.europe_teams) {
			const teamId = team.id;
			const leaguesForTeam = new Set();

			// 1. Primary league
			const primaryCompId = String(team.primary_domestic_league_id || '').toLowerCase().trim();
			const primaryLeagueId = resolveLeagueForCompetition(primaryCompId);
			if (primaryLeagueId) leaguesForTeam.add(primaryLeagueId);

			// 2. Leagues from games they participate in
			for (const game of europeData.europe_games) {
				if (game.home_team_id === teamId || game.away_team_id === teamId) {
					const gameCompId = String(game.competition_id || '').toLowerCase().trim();
					const gameLeagueId = resolveLeagueForCompetition(gameCompId);
					if (gameLeagueId) leaguesForTeam.add(gameLeagueId);
				}
			}

			// Fallback to euroleague if no league found
			if (leaguesForTeam.size === 0) leaguesForTeam.add('euroleague');

			for (const leagueId of leaguesForTeam) {
				if (!dataByLeague.has(leagueId)) {
					dataByLeague.set(leagueId, {
						players: [],
						teams: [],
						europe_competitions: [],
						europe_teams: [],
						europe_team_aliases: [],
						europe_players: [],
						europe_games: []
					});
				}
				const bucket = dataByLeague.get(leagueId);
				if (!bucket.europe_teams.find(t => t.id === teamId)) {
					bucket.europe_teams.push(team);
				}
			}
		}

		// Process europe_players - Ensure player is in EVERY league they play in
		for (const player of europeData.europe_players) {
			const playerId = player.id;
			const leaguesForPlayer = new Set();

			// 1. Assigned league
			const assignedCompId = String(player.league || '').toLowerCase().trim();
			const assignedLeagueId = resolveLeagueForCompetition(assignedCompId);
			if (assignedLeagueId) leaguesForPlayer.add(assignedLeagueId);

			// 2. Leagues from game stats they appear in
			for (const pstat of europeData.players) {
				if (pstat.player_id === playerId) {
					// We need the game's competition to find the league
					const game = europeData.europe_games.find(g => g.id === pstat.game_id);
					if (game) {
						const gameCompId = String(game.competition_id || '').toLowerCase().trim();
						const gameLeagueId = resolveLeagueForCompetition(gameCompId);
						if (gameLeagueId) leaguesForPlayer.add(gameLeagueId);
					}
				}
			}

			if (leaguesForPlayer.size === 0) leaguesForPlayer.add('euroleague');

			for (const leagueId of leaguesForPlayer) {
				if (!dataByLeague.has(leagueId)) {
					dataByLeague.set(leagueId, {
						players: [],
						teams: [],
						europe_competitions: [],
						europe_teams: [],
						europe_team_aliases: [],
						europe_players: [],
						europe_games: []
					});
				}
				const bucket = dataByLeague.get(leagueId);
				if (!bucket.europe_players.find(p => p.id === playerId)) {
					bucket.europe_players.push(player);
				}
			}
		}

		// Process europe_team_aliases - group by team_id's leagues
		for (const alias of europeData.europe_team_aliases) {
			const teamId = alias.team_id;
			// Find all leagues this team belongs to
			const targetLeagues = [];
			for (const [leagueId, bucket] of dataByLeague) {
				if (bucket.europe_teams.find(t => t.id === teamId)) {
					targetLeagues.push(leagueId);
				}
			}

			for (const leagueId of targetLeagues) {
				dataByLeague.get(leagueId).europe_team_aliases.push(alias);
			}
		}

		// Load data into each league's individual database
		for (const [leagueId, leagueData] of dataByLeague) {
			console.log(`📊 Loading ${leagueId.toUpperCase()} Europe data into ${EUROPE_LEAGUE_REGISTRY[leagueId].dbFile}...`);

			const db = await initDatabase(leagueId, leagueId);

			try {
				db.exec('BEGIN TRANSACTION');

				// Clear existing records for this league/year
				console.log(`🗑️ Clearing old database records for ${leagueId.toUpperCase()} - ${year}...`);
				db.prepare(`DELETE FROM player_game_stats WHERE league = ? AND season = ?`)
					.run(leagueId, String(year));
				db.prepare(`DELETE FROM team_game_stats WHERE league = ? AND season = ?`)
					.run(leagueId, String(year));

				// Normalize the 'league' column to the league ID (stat rows carry competition IDs)
				for (const player of leagueData.players) player.league = leagueId;
				for (const team of leagueData.teams) team.league = leagueId;

				// Batch insert players into player_game_stats
				if (leagueData.players && leagueData.players.length > 0) {
					console.log(`📥 Inserting ${leagueData.players.length} player rows into 'player_game_stats' for ${leagueId.toUpperCase()}...`);
					const keys = Object.keys(leagueData.players[0]);
					const placeholders = keys.map(() => '?').join(', ');
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO player_game_stats (${keys.join(', ')}) VALUES (${placeholders})`);
					for (const player of leagueData.players) {
						const values = keys.map(k => player[k]);
						insertStmt.run(...values);
					}
				}

				// Batch insert teams into team_game_stats
				if (leagueData.teams && leagueData.teams.length > 0) {
					console.log(`📥 Inserting ${leagueData.teams.length} team rows into 'team_game_stats' for ${leagueId.toUpperCase()}...`);
					const keys = Object.keys(leagueData.teams[0]);
					const placeholders = keys.map(() => '?').join(', ');
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO team_game_stats (${keys.join(', ')}) VALUES (${placeholders})`);
					for (const team of leagueData.teams) {
						const values = keys.map(k => team[k]);
						insertStmt.run(...values);
					}
				}

				// Supplemental European Referential Tables
				if (leagueData.europe_competitions && leagueData.europe_competitions.length > 0) {
					console.log(`📥 Inserting ${leagueData.europe_competitions.length} rows into 'competitions' for ${leagueId.toUpperCase()}...`);
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO competitions (id, name, type) VALUES (?, ?, ?)`);
					for (const c of leagueData.europe_competitions) {
						insertStmt.run(c.id, c.name, c.type);
					}
				}

				if (leagueData.europe_teams && leagueData.europe_teams.length > 0) {
					console.log(`📥 Inserting ${leagueData.europe_teams.length} rows into 'teams' for ${leagueId.toUpperCase()}...`);
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO teams (id, canonical_name, country_code, primary_domestic_league_id) VALUES (?, ?, ?, ?)`);
					for (const t of leagueData.europe_teams) {
						insertStmt.run(t.id, t.canonical_name, t.country_code, t.primary_domestic_league_id);
					}
				}

				if (leagueData.europe_team_aliases && leagueData.europe_team_aliases.length > 0) {
					console.log(`📥 Inserting ${leagueData.europe_team_aliases.length} rows into 'team_aliases' for ${leagueId.toUpperCase()}...`);
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO team_aliases (alias, team_id) VALUES (?, ?)`);
					for (const ta of leagueData.europe_team_aliases) {
						insertStmt.run(ta.alias, ta.team_id);
					}
				}

				if (leagueData.europe_players && leagueData.europe_players.length > 0) {
					console.log(`📥 Inserting ${leagueData.europe_players.length} rows into 'players' for ${leagueId.toUpperCase()}...`);
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO players (id, canonical_name, normalized_name) VALUES (?, ?, ?)`);
					for (const p of leagueData.europe_players) {
						insertStmt.run(p.id, p.canonical_name, p.normalized_name);
					}
				}

				if (leagueData.europe_games && leagueData.europe_games.length > 0) {
					console.log(`📥 Inserting ${leagueData.europe_games.length} rows into 'games' for ${leagueId.toUpperCase()}...`);
					const insertStmt = db.prepare(`INSERT OR REPLACE INTO games (id, competition_id, season_id, game_date, home_team_id, away_team_id, home_score, away_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
					for (const g of leagueData.europe_games) {
						insertStmt.run(g.id, g.competition_id, g.season_id, g.game_date, g.home_team_id, g.away_team_id, g.home_score, g.away_score);
					}
				}

				db.exec('COMMIT');
				console.log(`✅ Stage 3 [LOAD] complete for ${leagueId.toUpperCase()} Europe data.`);
			} catch (error) {
				db.exec('ROLLBACK');
				console.error(`❌ Database TRANSACTION failure for ${leagueId.toUpperCase()}:`, error);
				throw error;
			} finally {
				db.close();
			}
		}

		console.log(`✅ Stage 3 [LOAD] complete. European data distributed across per-league databases.\n`);
		return;
	}

	// ------------------------------------------------------------
	// ORIGINAL NON-EUROPE LEAGUE LOAD LOGIC (NBA, WNBA, etc.)
	// ------------------------------------------------------------
	console.log(`💾 Connecting to SQLite local staging database [data/SQL/${league.toUpperCase()}.sqlite]...`);
	const db = await initDatabase(league);

	try {
		db.exec('BEGIN TRANSACTION');

		// Clear existing records for this league/year to keep stage runs idempotent
		console.log(`🗑️ Clearing old database records for ${league.toUpperCase()} - ${year}...`);
		db.prepare(`DELETE FROM player_game_stats WHERE league = ? AND season = ?`)
			.run(league, String(year));
		db.prepare(`DELETE FROM team_game_stats WHERE league = ? AND season = ?`)
			.run(league, String(year));

		// Batch insert players in chunks of 100 to avoid SQLite limits
		if (players.length > 0) {
			console.log(`📥 Inserting ${players.length} player rows into 'player_game_stats'...`);
			const keys = Object.keys(players[0]);
			const placeholders = keys.map(() => '?').join(', ');
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO player_game_stats (${keys.join(', ')}) VALUES (${placeholders})`);
			for (const player of players) {
				const values = keys.map(k => player[k]);
				insertStmt.run(...values);
			}
		}

		// Batch insert teams in chunks of 100
		if (teams.length > 0) {
			console.log(`📥 Inserting ${teams.length} team rows into 'team_game_stats'...`);
			const keys = Object.keys(teams[0]);
			const placeholders = keys.map(() => '?').join(', ');
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO team_game_stats (${keys.join(', ')}) VALUES (${placeholders})`);
			for (const team of teams) {
				const values = keys.map(k => team[k]);
				insertStmt.run(...values);
			}
		}

		// Supplemental European Referential Tables (only applies if data includes them)
		if (data && data.europe_competitions && data.europe_competitions.length > 0) {
			console.log(`📥 Inserting ${data.europe_competitions.length} rows into 'competitions'...`);
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO competitions (id, name, type) VALUES (?, ?, ?)`);
			for (const c of data.europe_competitions) {
				insertStmt.run(c.id, c.name, c.type);
			}
		}

		if (data && data.europe_teams && data.europe_teams.length > 0) {
			console.log(`📥 Inserting ${data.europe_teams.length} rows into 'teams'...`);
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO teams (id, canonical_name, country_code, primary_domestic_league_id) VALUES (?, ?, ?, ?)`);
			for (const t of data.europe_teams) {
				insertStmt.run(t.id, t.canonical_name, t.country_code, t.primary_domestic_league_id);
			}
		}

		if (data && data.europe_team_aliases && data.europe_team_aliases.length > 0) {
			console.log(`📥 Inserting ${data.europe_team_aliases.length} rows into 'team_aliases'...`);
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO team_aliases (alias, team_id) VALUES (?, ?)`);
			for (const ta of data.europe_team_aliases) {
				insertStmt.run(ta.alias, ta.team_id);
			}
		}

		if (data && data.europe_players && data.europe_players.length > 0) {
			console.log(`📥 Inserting ${data.europe_players.length} rows into 'players'...`);
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO players (id, canonical_name, normalized_name) VALUES (?, ?, ?)`);
			for (const p of data.europe_players) {
				insertStmt.run(p.id, p.canonical_name, p.normalized_name);
			}
		}

		if (data && data.europe_games && data.europe_games.length > 0) {
			console.log(`📥 Inserting ${data.europe_games.length} rows into 'games'...`);
			const insertStmt = db.prepare(`INSERT OR REPLACE INTO games (id, competition_id, season_id, game_date, home_team_id, away_team_id, home_score, away_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
			for (const g of data.europe_games) {
				insertStmt.run(g.id, g.competition_id, g.season_id, g.game_date, g.home_team_id, g.away_team_id, g.home_score, g.away_score);
			}
		}

		db.exec('COMMIT');
		console.log(`✅ Stage 3 [LOAD] complete. Successfully saved records to local staging database.`);
	} catch (error) {
		db.exec('ROLLBACK');
		console.error(`❌ Database TRANSACTION failure:`, error);
		throw error;
	} finally {
		db.close();
	}
}