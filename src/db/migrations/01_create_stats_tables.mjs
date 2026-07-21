/**
 * @description Migration UP: Creates the player_game_stats and team_game_stats tables.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 */
export function up(db) {
	db.exec(`
		CREATE TABLE player_game_stats (
			game_id TEXT,
			player_id INTEGER,
			player_name TEXT,
			normalized_name TEXT,
			team_id INTEGER,
			team_abbreviation TEXT,
			team_city TEXT,
			start_position TEXT,
			comment TEXT,
			min TEXT,
			fgm INTEGER,
			fga INTEGER,
			fg_pct REAL,
			fg3m INTEGER,
			fg3a INTEGER,
			fg3_pct REAL,
			ftm INTEGER,
			fta INTEGER,
			ft_pct REAL,
			oreb INTEGER,
			dreb INTEGER,
			reb INTEGER,
			ast INTEGER,
			stl INTEGER,
			blk INTEGER,
			tov INTEGER,
			pf INTEGER,
			pts INTEGER,
			plus_minus REAL,
			ts_pct REAL,
			efg_pct REAL,
			game_score REAL,
			season TEXT,
			league TEXT,
			synced INTEGER DEFAULT 0,
			PRIMARY KEY (game_id, player_id)
		);

		CREATE TABLE team_game_stats (
			game_id TEXT,
			team_id INTEGER,
			team_name TEXT,
			team_abbreviation TEXT,
			team_city TEXT,
			min TEXT,
			fgm INTEGER,
			fga INTEGER,
			fg_pct REAL,
			fg3m INTEGER,
			fg3a INTEGER,
			fg3_pct REAL,
			ftm INTEGER,
			fta INTEGER,
			ft_pct REAL,
			oreb INTEGER,
			dreb INTEGER,
			reb INTEGER,
			ast INTEGER,
			stl INTEGER,
			blk INTEGER,
			tov INTEGER,
			pf INTEGER,
			pts INTEGER,
			plus_minus REAL,
			ts_pct REAL,
			efg_pct REAL,
			season TEXT,
			league TEXT,
			synced INTEGER DEFAULT 0,
			PRIMARY KEY (game_id, team_id)
		);
	`);
}

/**
 * @description Migration DOWN: Drops the player_game_stats and team_game_stats tables.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 */
export function down(db) {
	db.exec(`
		DROP TABLE IF EXISTS team_game_stats;
		DROP TABLE IF EXISTS player_game_stats;
	`);
}
