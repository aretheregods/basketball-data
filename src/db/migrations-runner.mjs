import fs from 'fs/promises';
import path from 'path';

/**
 * @description Runs all pending migrations for the provided node:sqlite database.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite DatabaseSync connection
 * @returns {Promise<void>}
 */
export async function runMigrations(db) {
	// Ensure schema_migrations table exists
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE,
			run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Read all run migrations
	const runMigrationsList = db.prepare('SELECT name FROM schema_migrations').all();
	const runSet = new Set(runMigrationsList.map(r => r.name));

	const migrationsDir = path.resolve('src/db/migrations');

	// Create directory if it doesn't exist
	await fs.mkdir(migrationsDir, { recursive: true });

	const files = await fs.readdir(migrationsDir);
	const migrationFiles = files
		.filter(f => f.endsWith('.mjs') || f.endsWith('.js'))
		.sort(); // Sort lexicographically by name/timestamp

	for (const file of migrationFiles) {
		if (runSet.has(file)) {
			continue;
		}

		console.log(`🚀 Running migration: ${file}...`);

		// Dynamic import (resolved as file:// URL for ES Modules safety)
		const filePath = path.join(migrationsDir, file);
		const migrationModule = await import(`file://${filePath}`);

		if (typeof migrationModule.up !== 'function') {
			throw new Error(`Migration ${file} does not export an 'up' function.`);
		}

		db.exec('BEGIN TRANSACTION');
		try {
			migrationModule.up(db);
			db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
			db.exec('COMMIT');
			console.log(`✅ Completed migration: ${file}`);
		} catch (error) {
			db.exec('ROLLBACK');
			console.error(`❌ Migration failed at ${file}:`, error);
			throw error;
		}
	}
}
