import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { BaseNormalizer } from '../utils/BaseNormalizer.mjs';

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
			const rawPbp = this.getRawPbpStats(leagueKey);
			const pbpSeasons = [...new Set([...this.getPbpSeasons(), ...Object.keys(rawPbp)])];
			const rawSeasons = this.getRawSeasons(leagueKey);
			const seasons = [...new Set([...dbSeasons, ...pbpSeasons, ...rawSeasons])].sort((a, b) => b - a);

			const report = {
				seasons: {},
				totalGames: 0,
				totalScoreMismatches: 0,
				totalMissingBoxscores: 0,
				totalUnsyncedGames: 0,
				totalUnsyncedStats: 0,
				totalOutliers: 0,
				totalLowMinAnomalies: 0,
				totalUnplayedGames: 0,
				totalPbpGames: 0,
				totalPbpEvents: 0,
				totalPbpStints: 0
			};

			for (const season of seasons) {
				const gamesCount = this.getGamesCount(season);
				const missingBoxscores = this.getMissingBoxscores(season);
				const scoreMismatches = this.getScoreMismatches(season);
				const lowMinAnomalies = this.getLowMinAnomalies(season);
				const outliers = this.getOutliers(season);
				const syncStatus = this.getSyncStatus(season);
				const unplayedGames = this.getUnplayedGamesFromRaw(leagueKey, season);
				const pbpStats = this.getPbpStats(season, gamesCount);
				this.mergePbpStats(pbpStats, rawPbp[season]);
				if (gamesCount > 0) {
					pbpStats.pbpCoveragePct = Number(((pbpStats.pbpGamesCount / gamesCount) * 100).toFixed(1));
				}

				report.seasons[season] = {
					gamesCount,
					missingBoxscores,
					scoreMismatches,
					lowMinAnomalies,
					outliers,
					syncStatus,
					unplayedGames,
					pbpStats
				};

				report.totalGames += gamesCount;
				report.totalMissingBoxscores += missingBoxscores.length;
				report.totalScoreMismatches += scoreMismatches.length;
				report.totalLowMinAnomalies += lowMinAnomalies.length;
				report.totalOutliers += outliers.length;
				report.totalUnsyncedGames += syncStatus.unsyncedGames;
				report.totalUnsyncedStats += syncStatus.unsyncedStats;
				report.totalUnplayedGames += unplayedGames.length;
				report.totalPbpGames += pbpStats.pbpGamesCount;
				report.totalPbpEvents += pbpStats.pbpEventsCount;
				report.totalPbpStints += pbpStats.pbpStintsCount;
			}

			return report;
		} finally {
			this.close();
		}
	}

	/**
	 * @description Reads PBP file presence and approximate event counts from raw season folders.
	 * @param {string} leagueKey - Lowercase league database key
	 * @returns {Record<string, { pbpGamesCount: number, pbpEventsCount: number }>} Raw PBP stats by season
	 */
	getRawPbpStats(leagueKey) {
		const competitionFolders = {
			euroleague: ['euroleague'],
			eurocup: ['eurocup'],
			basketball_champions_league: ['bcl'],
			fiba_europe_cup: ['fiba_europe_cup', 'fec'],
			acb: ['acb'],
			greek_basketball: ['gbl'],
			italian_serie_a_basketball: ['lba'],
			french_pro_a: ['lnb'],
			german_bbl: ['bbl'],
			lithuanian_lkl: ['lkl'],
			adriatic_basketball: ['aba'],
			israeli_basketball: ['bsl', 'israel'],
			bnxt: ['bnxt'],
			finnish_korsiliiga: ['korisliiga'],
			british_basketball: ['british_basketball', 'bbl_gb']
		};
		const root = leagueKey === 'europe' ? path.resolve('data/raw/europe/pbp') : null;
		const folders = root ? fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)) : [] :
			(competitionFolders[leagueKey] || []).map(folder => path.resolve('data/raw/europe/pbp', folder));
		/** @type {Record<string, { pbpGamesCount: number, pbpEventsCount: number }>} */
		const stats = {};
		for (const folder of folders) {
			let seasons;
			try {
				seasons = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d{4}$/.test(entry.name));
			} catch (error) {
				continue;
			}
			for (const seasonDir of seasons) {
				const seasonPath = path.join(folder, seasonDir.name);
				let files;
				try {
					files = fs.readdirSync(seasonPath).filter(file => file.endsWith('.json'));
				} catch (error) {
					continue;
				}
				const seasonStats = stats[seasonDir.name] || { pbpGamesCount: 0, pbpEventsCount: 0 };
				for (const file of files) {
					try {
						const raw = JSON.parse(fs.readFileSync(path.join(seasonPath, file), 'utf8'));
						const actions = raw?.pbp?.Rows || raw?.pbp?.actions || raw?.pbp || raw?.actions || raw?.plays || raw?.events || [];
						const eventCount = Array.isArray(actions) ? actions.length :
							(actions && typeof actions === 'object' ? Object.values(actions).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0) : 0);
						if (eventCount > 0) {
							seasonStats.pbpGamesCount++;
							seasonStats.pbpEventsCount += eventCount;
						}
					} catch (error) {
						// Skip invalid cached source files.
					}
				}
				stats[seasonDir.name] = seasonStats;
			}
		}
		return stats;
	}

	/**
	 * @description Combines raw download presence with loaded PBP counts, preferring the larger count per metric.
	 * @param {{ pbpGamesCount: number, pbpCoveragePct: number, pbpEventsCount: number, pbpStintsCount: number }} loadedStats - Stats from SQLite
	 * @param {{ pbpGamesCount: number, pbpEventsCount: number }} [rawStats] - Stats from raw downloaded files
	 * @returns {void}
	 */
	mergePbpStats(loadedStats, rawStats) {
		if (!rawStats) return;
		loadedStats.pbpGamesCount = Math.max(loadedStats.pbpGamesCount, rawStats.pbpGamesCount);
		loadedStats.pbpEventsCount = Math.max(loadedStats.pbpEventsCount, rawStats.pbpEventsCount);
	}

	/**
	 * @description Finds raw seasons in the current league's traditional or PBP directory.
	 * European PBP files are stored under the shared europe/pbp/<competition>/<season> tree.
	 * @param {string} leagueKey - Lowercase database key
	 * @returns {string[]} Raw seasons available for this database
	 */
	getRawSeasons(leagueKey) {
		const seasons = new Set();
		const directories = [path.resolve('data/raw', leagueKey)];
		const europeanCompetitionFolders = {
			euroleague: ['euroleague'],
			eurocup: ['eurocup'],
			basketball_champions_league: ['bcl'],
			acb: ['acb'],
			greek_basketball: ['gbl'],
			italian_serie_a_basketball: ['lba'],
			french_pro_a: ['lnb'],
			german_bbl: ['bbl'],
			lithuanian_lkl: ['lkl'],
			adriatic_basketball: ['aba'],
			israeli_basketball: ['bsl', 'israel'],
			bnxt: ['bnxt'],
			finnish_korsiliiga: ['korisliiga'],
			british_basketball: ['british_basketball']
		};
		for (const folder of europeanCompetitionFolders[leagueKey] || []) {
			directories.push(path.resolve('data/raw/europe/pbp', folder));
		}
		for (const directory of directories) {
			try {
				for (const dir of fs.readdirSync(directory, { withFileTypes: true })) {
					if (dir.isDirectory() && /^\d{4}$/.test(dir.name)) seasons.add(dir.name);
				}
			} catch (error) {
				// Raw files are optional; the database remains the source of loaded seasons.
			}
		}
		return [...seasons];
	}

	/**
	 * @description Retrieves seasons represented by play-by-play events or stints.
	 * @returns {string[]} Seasons inferred from catalogs, linked stats, competition IDs, or event IDs
	 */
	getPbpSeasons() {
		const seasons = new Set();
		try {
			const gamesTable = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='games'`).get();
			if (gamesTable) {
				const rows = this.db.prepare(`SELECT DISTINCT season_id FROM games WHERE season_id IS NOT NULL AND season_id != ''`).all();
				for (const row of rows) seasons.add(String(row.season_id));
			}
		} catch (error) {
			// Non-European databases do not have the European games catalog.
		}
		for (const table of ['game_play_by_play', 'game_stints']) {
			try {
				const exists = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
				if (!exists) continue;
				const rows = this.db.prepare(`
					SELECT DISTINCT t.season AS season, p.competition_id AS competition_id, p.game_id AS game_id
					FROM ${table} p
					LEFT JOIN team_game_stats t ON p.game_id = t.game_id
				`).all();
				for (const row of rows) {
					if (row.season !== null && row.season !== undefined && row.season !== '') seasons.add(String(row.season));
					for (const value of [row.competition_id, row.game_id]) {
						// Season identifiers are prefixes (NBL2025, U2026, F2026_...),
						// never arbitrary four-digit fragments within event IDs or UUIDs.
						const match = String(value || '').match(/^[A-Z_-]*((?:19|20)\d{2})(?=_|$)/i);
						if (match) seasons.add(match[1]);
					}
				}
			} catch (error) {
				// PBP may exist in older schemas without stats tables or expected columns.
			}
		}
		return [...seasons];
	}

	/**
	 * @description Computes PBP statistics (events, stints, coverage %) for a season.
	 * @param {string} season - The season year
	 * @param {number} totalGames - Total games in season
	 * @returns {Object} PBP stats
	 */
	getPbpStats(season, totalGames = 0) {
		const res = { pbpGamesCount: 0, pbpCoveragePct: 0, pbpEventsCount: 0, pbpStintsCount: 0 };
		try {
			// Check if game_play_by_play table exists
			const tableCheck = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='game_play_by_play'`).get();
			const stintsTableCheck = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='game_stints'`).get();
			if (!tableCheck && !stintsTableCheck) return res;

			const seasonStr = String(season);
			const gamesTable = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='games'`).get();
			const statsTable = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_game_stats'`).get();
			const seasonGameConditions = [];
			if (gamesTable) seasonGameConditions.push('p.game_id IN (SELECT id FROM games WHERE season_id = ?)');
			if (statsTable) seasonGameConditions.push('p.game_id IN (SELECT DISTINCT game_id FROM team_game_stats WHERE season = ?)');
			const fallbackSeasonConditions = [];
			const fallbackSeasonParams = [];
			if (!seasonGameConditions.length) {
				fallbackSeasonConditions.push('p.competition_id LIKE ?', 'p.event_id LIKE ?');
				fallbackSeasonParams.push(`%${seasonStr}%`, `%${seasonStr}%`);
			}
			const seasonFilter = [...seasonGameConditions, ...fallbackSeasonConditions].join(' OR ') || '0';
			const seasonParams = [
				...(gamesTable ? [seasonStr] : []),
				...(statsTable ? [seasonStr] : []),
				...fallbackSeasonParams
			];

			if (tableCheck) {
				const pbpGamesStmt = this.db.prepare(`
					SELECT COUNT(DISTINCT p.game_id) as cnt
					FROM game_play_by_play p
					WHERE ${seasonFilter}
				`);
				const pbpGamesRow = pbpGamesStmt.get(...seasonParams);
				res.pbpGamesCount = pbpGamesRow ? pbpGamesRow.cnt : 0;

				const pbpEventsStmt = this.db.prepare(`
					SELECT COUNT(*) as cnt
					FROM game_play_by_play p
					WHERE ${seasonFilter}
				`);
				const pbpEventsRow = pbpEventsStmt.get(...seasonParams);
				res.pbpEventsCount = pbpEventsRow ? pbpEventsRow.cnt : 0;
			}

			// Check if game_stints table exists
			if (stintsTableCheck) {
				const stintSeasonConditions = [];
				if (gamesTable) stintSeasonConditions.push('s.game_id IN (SELECT id FROM games WHERE season_id = ?)');
				if (statsTable) stintSeasonConditions.push('s.game_id IN (SELECT DISTINCT game_id FROM team_game_stats WHERE season = ?)');
				const stintFallbackConditions = stintSeasonConditions.length ? [] : ['s.competition_id LIKE ?', 's.stint_id LIKE ?'];
				const stintFilter = [...stintSeasonConditions, ...stintFallbackConditions].join(' OR ') || '0';
				const pbpStintsStmt = this.db.prepare(`
					SELECT COUNT(*) as cnt
					FROM game_stints s
					WHERE ${stintFilter}
				`);
				const stintParams = [
					...stintSeasonConditions.map(() => seasonStr),
					...stintFallbackConditions.map(() => `%${seasonStr}%`)
				];
				const pbpStintsRow = pbpStintsStmt.get(...stintParams);
				res.pbpStintsCount = pbpStintsRow ? pbpStintsRow.cnt : 0;
			}

			if (totalGames > 0) {
				res.pbpCoveragePct = Number(((res.pbpGamesCount / totalGames) * 100).toFixed(1));
			}
		} catch (e) {
			// Fail-safe
		}
		return res;
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
							if (raw && BaseNormalizer.isGameUnplayed(raw, leagueKey)) {
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
		let count = 0;
		try {
			const stmt = this.db.prepare(`
				SELECT COUNT(DISTINCT game_id) as cnt
				FROM team_game_stats
				WHERE season = ?
			`);
			const row = stmt.get(season);
			count = row ? row.cnt : 0;
		} catch (e) {
			// Some European seasons are represented only in the games catalog.
		}
		try {
			const gamesTable = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='games'`).get();
			if (gamesTable) {
				const row = this.db.prepare('SELECT COUNT(DISTINCT id) AS cnt FROM games WHERE season_id = ?').get(String(season));
				count = Math.max(count, row?.cnt || 0);
			}
		} catch (error) {
			// Keep the team stats count when the games catalog has a different schema.
		}
		return count;
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
