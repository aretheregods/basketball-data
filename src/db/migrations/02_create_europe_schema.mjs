/**
 * @description Migration UP: Creates the competitions, teams, team_aliases, players, and games tables for a European league database.
 * These tables are only created for European league databases (identified by leagueId).
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 * @param {string} [leagueId=''] - The league identifier (e.g. 'euroleague', 'acb')
 */
export function up(db, leagueId = '') {
	// Only create European schema tables for European leagues
	// Non-European leagues (NBA, WNBA, etc.) don't need these tables
	if (!leagueId) {
		return;
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS competitions (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			type TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS teams (
			id TEXT PRIMARY KEY,
			canonical_name TEXT NOT NULL,
			country_code TEXT NOT NULL,
			primary_domestic_league_id TEXT REFERENCES competitions(id)
		);

		CREATE TABLE IF NOT EXISTS team_aliases (
			alias TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES teams(id)
		);

		CREATE TABLE IF NOT EXISTS players (
			id TEXT PRIMARY KEY,
			canonical_name TEXT NOT NULL,
			normalized_name TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS games (
			id TEXT PRIMARY KEY,
			competition_id TEXT NOT NULL REFERENCES competitions(id),
			season_id TEXT NOT NULL,
		 game_date TEXT NOT NULL,
			home_team_id TEXT NOT NULL REFERENCES teams(id),
			away_team_id TEXT NOT NULL REFERENCES teams(id),
			home_score INTEGER,
			away_score INTEGER
		);
	`);
}

/**
 * @description Migration DOWN: Drops the European tables.
 * @param {import('node:sqlite').DatabaseSync} db - The node:sqlite database connection
 * @param {string} [leagueId=''] - The league identifier
 */
export function down(db, leagueId = '') {
	if (!leagueId) {
		return;
	}

	db.exec(`
		DROP TABLE IF EXISTS games;
		DROP TABLE IF EXISTS players;
		DROP TABLE IF EXISTS team_aliases;
		DROP TABLE IF EXISTS teams;
		DROP TABLE IF EXISTS competitions;
	`);
}
