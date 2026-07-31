import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

/**
 * @file AuditEngine.mjs
 * @description Runs SQL-based health and validation queries across isolated basketball SQLite databases.
 */

export class AuditEngine {
	/**
	 * @param {string} dbPath - Path to the SQLite database file
	 */
	constructor(dbPath) {
		this.dbPath = dbPath;
		this.db = null;
	}

	/**
	 * @description Connects to the SQLite database in read-only mode if supported.
	 * (Note: DatabaseSync does not currently have a clean readonly flag option in all Node 22 versions,
	 * so we instantiate it directly).
	 */
	connect() {
		if (!this.db) {
			this.db = new DatabaseSync(this.dbPath);
		}
	}

	/**
	 * @description Closes the database connection.
	 */
	close() {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * @description Runs the full health check suite across all tables.
	 * @returns {Object} Full audit report grouped by season
	 */
	runFullAudit() {
		this.connect();
		try {
			const leagueKey = path.basename(this.dbPath, '.sqlite').toLowerCase();
			const dbSeasons = this.getSeasons();
			const rawSeasons = [];
			const rawLeagueDir = path.resolve('data/raw', leagueKey);
			if (fs.existsSync(rawLeagueDir)) {
				try {
					const dirs = fs.readdirSync(rawLeagueDir);
					for (const dir of dirs) {
						if (/^\d{4}$/.test(dir)) {
							rawSeasons.push(dir);
						}
					}
				} catch (e) {}
			}
			const seasons = [...new Set([...dbSeasons, ...rawSeasons])].sort((a, b) => b - a);

			const report = {
				seasons: {},
				totalGames: 0,
				totalScoreMismatches: 0,
				totalMissingBoxscores: 0,
				totalUnsyncedGames: 0,
				totalUnsyncedStats: 0,
				totalOutliers: 0,
				totalLowMinAnomalies: 0,
				totalUnplayedGames: 0
			};

			for (const season of seasons) {
				const gamesCount = this.getGamesCount(season);
				const missingBoxscores = this.getMissingBoxscores(season);
				const scoreMismatches = this.getScoreMismatches(season);
				const lowMinAnomalies = this.getLowMinAnomalies(season);
				const outliers = this.getOutliers(season);
				const syncStatus = this.getSyncStatus(season);
				const unplayedGames = this.getUnplayedGamesFromRaw(leagueKey, season);

				report.seasons[season] = {
					gamesCount,
					missingBoxscores,
					scoreMismatches,
					lowMinAnomalies,
					outliers,
					syncStatus,
					unplayedGames
				};

				report.totalGames += gamesCount;
				report.totalMissingBoxscores += missingBoxscores.length;
				report.totalScoreMismatches += scoreMismatches.length;
				report.totalLowMinAnomalies += lowMinAnomalies.length;
				report.totalOutliers += outliers.length;
				report.totalUnsyncedGames += syncStatus.unsyncedGames;
				report.totalUnsyncedStats += syncStatus.unsyncedStats;
				report.totalUnplayedGames += unplayedGames.length;
			}

			return report;
		} finally {
			this.close();
		}
	}

	/**
	 * @description Scans raw game JSON files to find unplayed games.
	 * @param {string} leagueKey - League key name
	 * @param {string|number} season - The season year
	 * @returns {Array<{ gameId: string, filePath: string }>} List of unplayed games
	 */
	getUnplayedGamesFromRaw(leagueKey, season) {
		const unplayedGames = [];
		const rawSeasonDir = path.resolve('data/raw', leagueKey, String(season));
		if (fs.existsSync(rawSeasonDir)) {
			try {
				const files = fs.readdirSync(rawSeasonDir);
				for (const file of files) {
					if (file.endsWith('.json')) {
						const filePath = path.join(rawSeasonDir, file);
						try {
							const content = fs.readFileSync(filePath, 'utf8');
							const raw = JSON.parse(content);
							if (raw && (
								(raw.homeTeam && raw.homeTeam.teamName === 'Unplayed') ||
								(raw.awayTeam && raw.awayTeam.teamName === 'Unplayed')
							)) {
								unplayedGames.push({
									gameId: raw.gameId || file.replace('.json', ''),
									filePath: path.relative(path.resolve(), filePath)
								});
							}
						} catch (err) {}
					}
				}
			} catch (e) {}
		}
		return unplayedGames;
	}

	/**
	 * @description Retrieves all distinct seasons available in the database.
	 * @returns {string[]} List of seasons (sorted descending)
	 */
	getSeasons() {
		try {
			const stmt = this.db.prepare(`
				SELECT DISTINCT season
				FROM team_game_stats
				WHERE season IS NOT NULL AND season != ''
				ORDER BY season DESC
			`);
			const rows = stmt.all();
			return rows.map(r => String(r.season));
		} catch (e) {
			// If table doesn't exist or other error, return empty
			return [];
		}
	}

	/**
	 * @description Gets count of unique games for a season.
	 * @param {string} season - The season year
	 * @returns {number} Count of games
	 */
	getGamesCount(season) {
		try {
			const stmt = this.db.prepare(`
				SELECT COUNT(DISTINCT game_id) as cnt
				FROM team_game_stats
				WHERE season = ?
			`);
			const row = stmt.get(season);
			return row ? row.cnt : 0;
		} catch (e) {
			return 0;
		}
	}

	/**
	 * @description Find games where team stats are present but player box scores are missing.
	 * @param {string} season - The season year
	 * @returns {Array<Object>} List of games missing player box scores
	 */
	getMissingBoxscores(season) {
		try {
			// Find games where a team has records in team_game_stats but no matching records in player_game_stats
			const stmt = this.db.prepare(`
				SELECT DISTINCT t.game_id, t.team_id, t.team_name, t.season
				FROM team_game_stats t
				LEFT JOIN player_game_stats p ON t.game_id = p.game_id AND t.team_id = p.team_id
				WHERE t.season = ? AND p.game_id IS NULL
			`);
			return stmt.all(season);
		} catch (e) {
			return [];
		}
	}

	/**
	 * @description Find games where the sum of player points doesn't match the final team score.
	 * @param {string} season - The season year
	 * @returns {Array<Object>} List of mismatching games
	 */
	getScoreMismatches(season) {
		try {
			// Check if SUM(player pts) equals team_game_stats.pts
			const stmt = this.db.prepare(`
				SELECT
					t.game_id,
					t.team_id,
					t.team_name,
					t.pts as team_score,
					SUM(COALESCE(p.pts, 0)) as sum_player_pts,
					t.season
				FROM team_game_stats t
				LEFT JOIN player_game_stats p ON t.game_id = p.game_id AND t.team_id = p.team_id
				WHERE t.season = ?
				  -- Only check games that have some player stats to avoid overlap with missing boxscores
				  AND EXISTS (SELECT 1 FROM player_game_stats p2 WHERE p2.game_id = t.game_id)
				GROUP BY t.game_id, t.team_id, t.team_name, t.pts, t.season
				HAVING team_score != sum_player_pts
			`);
			return stmt.all(season);
		} catch (e) {
			return [];
		}
	}

	/**
	 * @description Find games where the total player minutes sum to an unphysically low amount.
	 * Regulation games should have close to 200 (for 40-minute leagues) or 240 (for 48-minute leagues) total minutes per team.
	 * @param {string} season - The season year
	 * @returns {Array<Object>} List of teams/games with low-minute anomalies
	 */
	getLowMinAnomalies(season) {
		try {
			const stmt = this.db.prepare(`
				SELECT
					game_id,
					team_id,
					team_name,
					SUM(COALESCE(CAST(min AS REAL), 0)) as total_player_minutes,
					season
				FROM player_game_stats
				WHERE season = ?
				GROUP BY game_id, team_id, team_name, season
				HAVING total_player_minutes < 150 AND total_player_minutes > 0
			`);
			return stmt.all(season);
		} catch (e) {
			return [];
		}
	}

	/**
	 * @description Detects negative values, extremely high scores or unphysical minutes played.
	 * @param {string} season - The season year
	 * @returns {Array<Object>} Outliers list
	 */
	getOutliers(season) {
		try {
			const stmt = this.db.prepare(`
				SELECT
					game_id,
					player_id,
					player_name,
					team_name,
					min,
					pts,
					reb,
					ast,
					season
				FROM player_game_stats
				WHERE season = ? AND (
					pts < 0 OR reb < 0 OR ast < 0 OR
					pts > 80 OR reb > 35 OR ast > 25 OR
					CAST(min AS REAL) > 60
				)
			`);
			return stmt.all(season);
		} catch (e) {
			return [];
		}
	}

	/**
	 * @description Computes unsynced record counts awaiting production push to Cloudflare D1.
	 * @param {string} season - The season year
	 * @returns {Object} Unsynced counts
	 */
	getSyncStatus(season) {
		const status = { unsyncedGames: 0, unsyncedStats: 0 };
		try {
			const stmtStats = this.db.prepare(`
				SELECT COUNT(*) as cnt
				FROM player_game_stats
				WHERE season = ? AND synced = 0
			`);
			const rowStats = stmtStats.get(season);
			if (rowStats) status.unsyncedStats = rowStats.cnt;

			const stmtGames = this.db.prepare(`
				SELECT COUNT(DISTINCT game_id) as cnt
				FROM team_game_stats
				WHERE season = ? AND synced = 0
			`);
			const rowGames = stmtGames.get(season);
			if (rowGames) status.unsyncedGames = rowGames.cnt;
		} catch (e) {
			// Table or column might not exist yet
		}
		return status;
	}
}
