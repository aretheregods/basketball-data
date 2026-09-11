/**
 * @description Migration UP: Ensures competition_id column exists on game_play_by_play and game_stints tables
 * for databases created prior to schema update 03_create_pbp_tables.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 */
export function up(db) {
	// 1. Ensure competition_id column in game_play_by_play
	const pbpTableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='game_play_by_play'`).get();
	if (pbpTableCheck) {
		const cols = db.prepare('PRAGMA table_info(game_play_by_play)').all();
		const hasCompId = cols.some(c => c.name === 'competition_id');
		if (!hasCompId) {
			db.exec('ALTER TABLE game_play_by_play ADD COLUMN competition_id TEXT;');
		}
	}

	// 2. Ensure competition_id column in game_stints
	const stintsTableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='game_stints'`).get();
	if (stintsTableCheck) {
		const cols = db.prepare('PRAGMA table_info(game_stints)').all();
		const hasCompId = cols.some(c => c.name === 'competition_id');
		if (!hasCompId) {
			db.exec('ALTER TABLE game_stints ADD COLUMN competition_id TEXT;');
		}
	}
}

/**
 * @description Migration DOWN: No-op for column additions.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 */
export function down(db) {
	// SQLite ALTER TABLE DROP COLUMN is not needed for no-op down migration
}
