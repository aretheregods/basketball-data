import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations-runner.mjs';

/**
 * @description Initializes the SQLite connection for a specific league and ensures schema tables exist.
 * Saves the SQLite file to `data/SQL/<LEAGUE>.sqlite` (e.g., `data/SQL/WNBA.sqlite`).
 *
 * @param {string} [league='wnba'] - The lowercase or uppercase league identifier
 * @returns {Promise<import('node:sqlite').DatabaseSync>} - The initialized DatabaseSync instance
 */
export async function initDatabase(league = 'wnba') {
	const dbDir = path.resolve('data/SQL');
	await fs.mkdir(dbDir, { recursive: true });

	const dbPath = path.join(dbDir, `${league.toUpperCase()}.sqlite`);

	const db = new DatabaseSync(dbPath);

	// Run pending database migrations
	await runMigrations(db);

	// Add destroy method as compatibility wrapper for test cleanups and syncStage
	db.destroy = () => {
		db.close();
	};

	return db;
}

/**
 * @description Runs the load stage: takes transformed objects (or loads from cache)
 * and batch inserts them to a local SQLite staging database inside a single transaction.
 *
 * @param {string} league - The lowercase league identifier (e.g., 'wnba')
 * @param {string|number} year - The season year (e.g., '2023')
 * @param {{ players?: Record<string, any>[], teams?: Record<string, any>[] }} [cleanedGamesArray] - Optional array of cleaned objects
 * @returns {Promise<void>}
 * @throws {Error} - If database initialization or loading fails
 */
export async function loadStage(league, year, cleanedGamesArray) {
	console.log(`📥 Starting Stage 3 [LOAD] for ${league.toUpperCase()} - ${year}`);

	let data = cleanedGamesArray;
	let hasDirectData = false;

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
			console.error(`❌ Transformed data cache file not found or failed to read at ${cachePath}.`);
			throw new Error(`Failed to load data for ${league.toUpperCase()} - ${year}. No direct data passed and fallback cache file not found or unreadable.`);
		}
	}

	const players = (data && data.players) || [];
	const teams = (data && data.teams) || [];

	if (players.length === 0 && teams.length === 0) {
		const msg = `❌ No player or team records to load for ${league.toUpperCase()} - ${year}.`;
		console.error(msg);
		throw new Error(msg);
	}

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

		// Supplemental European Referential Tables
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
		db.destroy();
	}
}
