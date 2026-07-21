import fs from 'fs/promises';
import path from 'path';
import knex from 'knex';

/**
 * @description Initializes the SQLite connection for a specific league and ensures schema tables exist.
 * Saves the SQLite file to `data/SQL/<LEAGUE>.sqlite` (e.g., `data/SQL/WNBA.sqlite`).
 *
 * @param {string} [league='wnba'] - The lowercase or uppercase league identifier
 * @returns {Promise<import('knex').Knex>} - The initialized Knex database instance
 */
export async function initDatabase(league = 'wnba') {
	const dbDir = path.resolve('data/SQL');
	await fs.mkdir(dbDir, { recursive: true });

	const dbPath = path.join(dbDir, `${league.toUpperCase()}.sqlite`);

	const db = knex({
		client: 'sqlite3',
		connection: {
			filename: dbPath
		},
		useNullAsDefault: true,
		migrations: {
			directory: path.resolve('src/db/migrations'),
			tableName: 'knex_migrations'
		}
	});

	// Run latest migrations programmatically
	await db.migrate.latest();

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

	// Load from cache if empty or not provided
	if (!data || (!Array.isArray(data.players) && !Array.isArray(data.teams))) {
		const cachePath = path.resolve('data/transformed', league, String(year), 'transformed.json');
		try {
			console.log(`📂 No memory cache passed. Loading transformed data from cache file: ${cachePath}`);
			const cacheContent = await fs.readFile(cachePath, 'utf8');
			data = JSON.parse(cacheContent);
		} catch (error) {
			console.warn(`⚠️ Transformed data cache file not found or failed to read at ${cachePath}. skipping Load.`);
			return;
		}
	}

	const players = data.players || [];
	const teams = data.teams || [];

	if (players.length === 0 && teams.length === 0) {
		console.log(`⚠️ No player or team records to load for ${league.toUpperCase()} - ${year}.`);
		return;
	}

	console.log(`💾 Connecting to SQLite local staging database [data/SQL/${league.toUpperCase()}.sqlite]...`);
	const db = await initDatabase(league);

	try {
		await db.transaction(async (trx) => {
			// Clear existing records for this league/year to keep stage runs idempotent
			console.log(`🗑️ Clearing old database records for ${league.toUpperCase()} - ${year}...`);
			await trx('player_game_stats').where({ league, season: String(year) }).del();
			await trx('team_game_stats').where({ league, season: String(year) }).del();

			// Batch insert players in chunks of 100 to avoid SQLite limits
			if (players.length > 0) {
				console.log(`📥 Inserting ${players.length} player rows into 'player_game_stats'...`);
				await trx.batchInsert('player_game_stats', players, 100);
			}

			// Batch insert teams in chunks of 100
			if (teams.length > 0) {
				console.log(`📥 Inserting ${teams.length} team rows into 'team_game_stats'...`);
				await trx.batchInsert('team_game_stats', teams, 100);
			}
		});

		console.log(`✅ Stage 3 [LOAD] complete. Successfully saved records to local staging database.`);
	} catch (error) {
		console.error(`❌ Database TRANSACTION failure:`, error);
		throw error;
	} finally {
		await db.destroy();
	}
}
