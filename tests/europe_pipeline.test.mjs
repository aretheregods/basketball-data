import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('European ETL Pipeline Integration', () => {
	const league = 'europe';
	const year = '2099'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		// Clean test directory cache
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		// Clean up generated data
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('should run extraction, transformation, and database load for Europe successfully', async () => {
		const scraper = new EuropeScraper({ competitions: 'euroleague' });

		// 1. STAGE 1: Extract
		const gameIds = await extractStage(scraper, league, year);
		assert.ok(gameIds.length > 0, 'Should return a non-empty list of extracted game IDs');

		const rawFile = path.resolve('data/raw', league, year, `${gameIds[0]}.json`);
		const rawExists = await fs.access(rawFile).then(() => true).catch(() => false);
		assert.equal(rawExists, true, 'Raw extracted JSON file must exist');

		// 2. STAGE 2: Transform
		const transformed = await transformStage(league, year);
		assert.ok(transformed.players.length > 0, 'Should produce transformed player rows');
		assert.ok(transformed.teams.length > 0, 'Should produce transformed team rows');
		assert.ok(transformed.europe_competitions.length > 0, 'Should produce reference competitions');
		assert.ok(transformed.europe_teams.length > 0, 'Should produce reference teams');

		// Check one resolved team and player
		const playerRow = transformed.players[0];
		assert.equal(typeof playerRow.player_id, 'string', 'Player ID should be canonical resolved string slug');
		assert.equal(typeof playerRow.team_id, 'string', 'Team ID should be canonical resolved string slug');

		// 3. STAGE 3: Load
		await loadStage(league, year, transformed);

		// 4. Query SQLite and verify
		const db = await initDatabase(league);
		try {
			// Verify player_game_stats
			const dbPlayers = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('euroleague', String(year));
			assert.ok(dbPlayers.length > 0);
			assert.equal(dbPlayers[0].team_city, 'Europe');

			// Verify supplemental European tables
			const dbCompetitions = db.prepare('SELECT * FROM competitions').all();
			assert.ok(dbCompetitions.some(c => c.id === 'euroleague'));

			const dbTeams = db.prepare('SELECT * FROM teams').all();
			assert.ok(dbTeams.some(t => t.id === 'real-madrid'));

			const dbGames = db.prepare('SELECT * FROM games WHERE season_id = ?').all(String(year));
			assert.ok(dbGames.length > 0);
			assert.equal(dbGames[0].competition_id, 'euroleague');
		} finally {
			db.destroy();
		}
	});
});
