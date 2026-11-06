import fs from 'fs/promises';
import path from 'path';
import child_process from 'child_process';
import { initDatabase } from './3-load.mjs';
import { isEuropeanLeague, getAllEuropeanLeagueIds } from '../db/europe_league_registry.mjs';

/**
 * @description Escapes any unsafe characters in a value for raw SQL insertion.
 * @param {any} val - The value to escape
 * @returns {string|number} - The escaped string, number, or 'NULL'
 */
function escapeSqlValue(val) {
	if (val === null || val === undefined) {
		return 'NULL';
	}
	if (typeof val === 'number') {
		return val;
	}
	if (typeof val === 'boolean') {
		return val ? 1 : 0;
	}
	// Escape single quotes for SQLite
	return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * @description Generates INSERT OR REPLACE SQL statements for a given collection.
 * @param {string} tableName - The name of the database table
 * @param {Record<string, any>[]} rows - The array of rows to format
 * @returns {string[]} - The generated SQL insert/replace statements
 */
function generateInsertStatements(tableName, rows) {
	const sqlLines = [];
	for (const row of rows) {
		// Filter out 'synced' column for production DB sync
		const cols = Object.keys(row).filter(k => k !== 'synced');
		const vals = cols.map(c => escapeSqlValue(row[c]));
		sqlLines.push(`INSERT OR REPLACE INTO ${tableName} (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
	}
	return sqlLines;
}

/**
 * @description Programmatically executes wrangler CLI to sync the local SQL file to Cloudflare D1.
 * @param {string} dbName - The name of the Cloudflare D1 database
 * @param {string} sqlFilePath - The path to the local temporary .sql file
 * @returns {Promise<void>}
 */
function runWranglerSync(dbName, sqlFilePath) {
	return new Promise((resolve, reject) => {
		console.log(`📡 Spawning Wrangler thread: wrangler d1 execute ${dbName} --remote --file=${sqlFilePath}`);

		// Use shell to execute wrangler in case wrangler is a globally installed CLI or shimmed by pnpm/npm
		const child = child_process.spawn('wrangler', ['d1', 'execute', dbName, '--remote', `--file=${sqlFilePath}`], {
			shell: true,
			stdio: 'pipe'
		});

		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (data) => {
			stdout += data.toString();
		});

		child.stderr.on('data', (data) => {
			stderr += data.toString();
		});

		child.on('close', (code) => {
			if (code !== 0) {
				const errMsg = stderr.trim() || stdout.trim() || `Exit code ${code}`;
				reject(new Error(`Wrangler execution failed: ${errMsg}`));
			} else {
				console.log(stdout);
				resolve();
			}
		});

		child.on('error', (err) => {
			reject(err);
		});
	});
}

/**
 * @description Syncs unsynced rows from a single league database.
 * @param {string} leagueId - The league identifier
 * @param {string|number} year - The season year
 * @param {Object} options - Sync options (databaseName, dryRun)
 * @returns {Promise<{ players: number, teams: number }>} Count of synced rows
 * @throws {Error} - If sync fails
 */
async function syncSingleLeague(leagueId, year, options) {
	const dbName = options.databaseName || process.env.D1_DATABASE_NAME || 'likelyhigh_db';
	const dryRun = options.dryRun || false;

	console.log(`🚀 Starting Stage 4 [SYNC] for ${leagueId.toUpperCase()} - ${year}`);

	console.log(`💾 Querying local staging database [data/SQL/${leagueId.toUpperCase()}.sqlite] for unsynced rows...`);
	const db = await initDatabase(leagueId);

	let playersToSync = [];
	let teamsToSync = [];

	try {
		playersToSync = db.prepare(`SELECT * FROM player_game_stats WHERE league = ? AND season = ? AND synced = 0`)
			.all(leagueId, String(year));

		teamsToSync = db.prepare(`SELECT * FROM team_game_stats WHERE league = ? AND season = ? AND synced = 0`)
			.all(leagueId, String(year));
	} catch (error) {
		console.warn(`⚠️ Failed to query local database. Have you run the load stage first?`);
		db.destroy();
		return { players: 0, teams: 0 };
	}

	if (playersToSync.length === 0 && teamsToSync.length === 0) {
		console.log(`✅ Everything is already synced! 0 unsynced rows found for ${leagueId.toUpperCase()} - ${year}.\n`);
		db.destroy();
		return { players: 0, teams: 0 };
	}

	console.log(`📦 Found ${playersToSync.length} unsynced players and ${teamsToSync.length} unsynced teams.`);

	// Create temp SQL file
	const tempDir = path.resolve('data/temp');
	await fs.mkdir(tempDir, { recursive: true });
	const tempFileName = `temp_delta_${leagueId}_${year}_${Date.now()}.sql`;
	const tempFilePath = path.join(tempDir, tempFileName);

	const playerStatements = generateInsertStatements('player_game_stats', playersToSync);
	const teamStatements = generateInsertStatements('team_game_stats', teamsToSync);
	const sqlContent = [...playerStatements, ...teamStatements].join('\n');

	await fs.writeFile(tempFilePath, sqlContent, 'utf8');
	console.log(`💾 Delta SQL file written to ${tempFilePath}`);

	if (dryRun) {
		console.log(`🧪 [DRY RUN] Skipping Wrangler sync execution.`);
		db.destroy();
		return { players: playersToSync.length, teams: teamsToSync.length };
	}

	try {
		await runWranglerSync(dbName, tempFilePath);

		// If successful, update synced flag to 1 locally
		console.log(`📝 Updating 'synced' flag to 1 in local staging database...`);

		db.exec('BEGIN TRANSACTION');
		try {
			if (playersToSync.length > 0) {
				db.prepare(`UPDATE player_game_stats SET synced = 1 WHERE league = ? AND season = ? AND synced = 0`)
					.run(leagueId, String(year));
			}
			if (teamsToSync.length > 0) {
				db.prepare(`UPDATE team_game_stats SET synced = 1 WHERE league = ? AND season = ? AND synced = 0`)
					.run(leagueId, String(year));
			}
			db.exec('COMMIT');
		} catch (trxError) {
			db.exec('ROLLBACK');
			throw trxError;
		}

		console.log(`✅ Stage 4 [SYNC] complete for ${leagueId.toUpperCase()}. Cloudflare D1 is now fully synced.`);
		return { players: playersToSync.length, teams: teamsToSync.length };
	} catch (error) {
		console.error(`❌ Wrangler Sync Failure for ${leagueId.toUpperCase()}:`, error.message);
		console.warn(`⚠️ The delta SQL file has been preserved at ${tempFilePath} for manual inspection.`);
		throw error;
	} finally {
		// Cleanup the temp file if sync was successful
		try {
			const fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
			if (fileExists && !dryRun) {
				await fs.unlink(tempFilePath);
				console.log(`🧹 Cleaned up temporary file ${tempFilePath}`);
			}
		} catch (cleanupErr) {
			console.error(`⚠️ Failed to cleanup ${tempFilePath}:`, cleanupErr);
		}
		db.destroy();
	}
}

/**
 * @description Runs the synchronization stage: queries local staging databases for unsynced rows,
 * packages them into temporary SQL files, spawns Wrangler to execute against Cloudflare D1,
 * and marks local rows as synced upon successful completion.
 *
 * For European leagues, syncs from each individual league database (euroleague.sqlite, acb.sqlite, etc.).
 *
 * @param {string} league - The lowercase league identifier (e.g., 'wnba')
 * @param {string|number} year - The season year (e.g., '2023')
 * @param {Object} [options] - Optional configurations
 * @param {string} [options.databaseName='likelyhigh_db'] - The Cloudflare D1 database name to sync with
 * @param {boolean} [options.dryRun=false] - If true, generates the delta file but does not execute wrangler
 * @returns {Promise<void>}
 * @throws {Error} - If database queries or Wrangler sync fail
 */
export async function syncStage(league, year, options = {}) {
	const dryRun = options.dryRun || false;

	// ------------------------------------------------------------
	// EUROPE LEAGUE SPLIT SYNC
	// ------------------------------------------------------------
	if (league.toLowerCase().startsWith('europe')) {
		console.log(`🌍 Detected European league. Syncing from per-league databases...`);

		const leagueIds = getAllEuropeanLeagueIds();
		let totalPlayers = 0;
		let totalTeams = 0;

		for (const leagueId of leagueIds) {
			try {
				const result = await syncSingleLeague(leagueId, year, options);
				totalPlayers += result.players;
				totalTeams += result.teams;
			} catch (error) {
				console.error(`❌ Sync failed for ${leagueId.toUpperCase()}:`, error.message);
			}
		}

		console.log(`✅ Stage 4 [SYNC] complete. Synced ${totalPlayers} players and ${totalTeams} teams across European databases.\n`);
		return;
	}

	// ------------------------------------------------------------
	// ORIGINAL SINGLE LEAGUE SYNC
	// ------------------------------------------------------------
	await syncSingleLeague(league, year, options);
}
