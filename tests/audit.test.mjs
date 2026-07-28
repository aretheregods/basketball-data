import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { AuditEngine } from '../src/audit/AuditEngine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/SQL/AUDIT_TEST.sqlite');

test.describe('AuditEngine Unit Tests', () => {
	let db;

	test.before(async () => {
		// Ensure the directory exists
		await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
		// Remove existing DB file if it exists
		await fs.rm(DB_PATH, { force: true });

		// Set up mock DB schema and data using DatabaseSync
		db = new DatabaseSync(DB_PATH);

		db.exec(`
			CREATE TABLE IF NOT EXISTS player_game_stats (
				game_id TEXT,
				player_id INTEGER,
				player_name TEXT,
				normalized_name TEXT,
				team_id INTEGER,
				team_name TEXT,
				min TEXT,
				pts INTEGER,
				reb INTEGER,
				ast INTEGER,
				season TEXT,
				league TEXT,
				synced INTEGER DEFAULT 0,
				PRIMARY KEY (game_id, player_id)
			);

			CREATE TABLE IF NOT EXISTS team_game_stats (
				game_id TEXT,
				team_id INTEGER,
				team_name TEXT,
				min TEXT,
				pts INTEGER,
				season TEXT,
				league TEXT,
				synced INTEGER DEFAULT 0,
				PRIMARY KEY (game_id, team_id)
			);
		`);

		// Scenario 1: A perfect game (gamesCount = 1)
		// game_id: 'G_01', season: '2025'
		// Team score: 80, Player sum: 30 + 50 = 80
		db.prepare(`
			INSERT INTO team_game_stats (game_id, team_id, team_name, min, pts, season, league, synced)
			VALUES ('G_01', 10, 'Team A', '200:00', 80, '2025', 'test-league', 1)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_01', 101, 'Player A1', 'Player A1', 10, 'Team A', '30.0', 30, 5, 5, '2025', 'test-league', 1)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_01', 102, 'Player A2', 'Player A2', 10, 'Team A', '25.0', 50, 5, 5, '2025', 'test-league', 1)
		`).run();

		// Scenario 2: Score mismatch
		// game_id: 'G_02', season: '2025'
		// Team score: 100, Player sum: 40 + 40 = 80 (Variance: 20)
		db.prepare(`
			INSERT INTO team_game_stats (game_id, team_id, team_name, min, pts, season, league, synced)
			VALUES ('G_02', 10, 'Team A', '200:00', 100, '2025', 'test-league', 0)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_02', 101, 'Player A1', 'Player A1', 10, 'Team A', '20.0', 40, 5, 5, '2025', 'test-league', 0)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_02', 102, 'Player A2', 'Player A2', 10, 'Team A', '20.0', 40, 5, 5, '2025', 'test-league', 0)
		`).run();

		// Scenario 3: Missing box score (exists in team stats, but not player stats)
		// game_id: 'G_03', season: '2025'
		db.prepare(`
			INSERT INTO team_game_stats (game_id, team_id, team_name, min, pts, season, league, synced)
			VALUES ('G_03', 20, 'Team B', '200:00', 90, '2025', 'test-league', 0)
		`).run();

		// Scenario 4: Low minutes anomaly (total player minutes < 150)
		// game_id: 'G_04', season: '2025'
		// Total minutes: 10.0 + 15.0 = 25.0 (well under 150)
		db.prepare(`
			INSERT INTO team_game_stats (game_id, team_id, team_name, min, pts, season, league, synced)
			VALUES ('G_04', 10, 'Team A', '200:00', 75, '2025', 'test-league', 0)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_04', 101, 'Player A1', 'Player A1', 10, 'Team A', '10.0', 25, 5, 5, '2025', 'test-league', 0)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_04', 102, 'Player A2', 'Player A2', 10, 'Team A', '15.0', 50, 5, 5, '2025', 'test-league', 0)
		`).run();

		// Scenario 5: Outlier (e.g., pts > 80 or reb < 0 or min > 60)
		// game_id: 'G_05', season: '2025'
		db.prepare(`
			INSERT INTO team_game_stats (game_id, team_id, team_name, min, pts, season, league, synced)
			VALUES ('G_05', 10, 'Team A', '200:00', 120, '2025', 'test-league', 0)
		`).run();
		db.prepare(`
			INSERT INTO player_game_stats (game_id, player_id, player_name, normalized_name, team_id, team_name, min, pts, reb, ast, season, league, synced)
			VALUES ('G_05', 101, 'Extreme Player', 'Extreme Player', 10, 'Team A', '42.0', 85, 36, 5, '2025', 'test-league', 0)
		`).run();

		db.close();
	});

	test.after(async () => {
		// Clean up database file
		await fs.rm(DB_PATH, { force: true });
	});

	test('should detect coverage, missing box scores, score mismatches, low minutes and outliers', () => {
		const engine = new AuditEngine(DB_PATH);
		const report = engine.runFullAudit();

		// Basic counts
		assert.equal(report.totalGames, 5); // G_01, G_02, G_03, G_04, G_05
		assert.equal(Object.keys(report.seasons).includes('2025'), true);

		const s2025 = report.seasons['2025'];

		// Verify missing box score for G_03
		assert.equal(s2025.missingBoxscores.length, 1);
		assert.equal(s2025.missingBoxscores[0].game_id, 'G_03');
		assert.equal(s2025.missingBoxscores[0].team_name, 'Team B');

		// Verify score mismatches (G_02 has 100 pts vs 80 sum, G_05 has 120 pts vs 85 sum)
		assert.equal(s2025.scoreMismatches.length, 2);
		const g02Mismatch = s2025.scoreMismatches.find(m => m.game_id === 'G_02');
		assert.ok(g02Mismatch);
		assert.equal(g02Mismatch.team_score, 100);
		assert.equal(g02Mismatch.sum_player_pts, 80);

		// Verify low minutes anomaly for G_04 (25 total minutes)
		// G_01 has 55.0 min (which is also < 150 min, so both G_01, G_04, G_05 are flagged since we inserted only 2 players per team). Let's check:
		assert.equal(s2025.lowMinAnomalies.length > 0, true);
		const g04Anomaly = s2025.lowMinAnomalies.find(a => a.game_id === 'G_04');
		assert.ok(g04Anomaly);
		assert.equal(g04Anomaly.total_player_minutes, 25.0);

		// Verify outlier (Extreme Player: pts=85, reb=36)
		assert.equal(s2025.outliers.length, 1);
		assert.equal(s2025.outliers[0].player_name, 'Extreme Player');
		assert.equal(s2025.outliers[0].pts, 85);
		assert.equal(s2025.outliers[0].reb, 36);

		// Verify syncStatus counts
		// Unsynced team rows: G_02, G_03, G_04, G_05 (4 games)
		// Unsynced player rows: G_02 (2), G_04 (2), G_05 (1) = 5 stats rows
		assert.equal(s2025.syncStatus.unsyncedGames, 4);
		assert.equal(s2025.syncStatus.unsyncedStats, 5);
	});
});
