/**
 * @description Migration UP: Creates game_play_by_play and game_stints tables with performance indexes.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 */
export function up(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS game_play_by_play (
			event_id TEXT PRIMARY KEY,
			game_id TEXT NOT NULL,
			period INTEGER NOT NULL,
			clock TEXT NOT NULL,
			seconds_remaining REAL NOT NULL,
			event_type INTEGER NOT NULL,
			sub_type INTEGER,
			team_id TEXT,
			player_id TEXT,
			secondary_player_id TEXT,
			description TEXT,
			home_score INTEGER NOT NULL,
			away_score INTEGER NOT NULL,
			loc_x REAL,
			loc_y REAL,
			shot_distance INTEGER,
			is_scoring_play INTEGER DEFAULT 0
		);

		CREATE INDEX IF NOT EXISTS idx_pbp_game_period ON game_play_by_play(game_id, period);
		CREATE INDEX IF NOT EXISTS idx_pbp_player ON game_play_by_play(player_id);

		CREATE TABLE IF NOT EXISTS game_stints (
			stint_id TEXT PRIMARY KEY,
			game_id TEXT NOT NULL,
			period INTEGER NOT NULL,
			start_clock TEXT NOT NULL,
			end_clock TEXT NOT NULL,
			duration_seconds REAL NOT NULL,
			home_lineup_hash TEXT NOT NULL,
			away_lineup_hash TEXT NOT NULL,
			home_pts INTEGER NOT NULL,
			away_pts INTEGER NOT NULL,
			possessions REAL NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_stints_game ON game_stints(game_id);
	`);
}

/**
 * @description Migration DOWN: Drops game_play_by_play and game_stints tables.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 */
export function down(db) {
	db.exec(`
		DROP TABLE IF EXISTS game_stints;
		DROP TABLE IF EXISTS game_play_by_play;
	`);
}
