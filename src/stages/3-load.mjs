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
