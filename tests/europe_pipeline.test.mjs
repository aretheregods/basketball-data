import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { EUROPE_LEAGUE_REGISTRY } from '../src/db/europe_league_registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('European ETL Pipeline Integration', () => {
	const league = 'europe';
	const year = '2024';

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		// Clean test directory cache
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
		// Clean individual league databases
		for (const leagueId of Object.keys(EUROPE_LEAGUE_REGISTRY)) {
			const config = EUROPE_LEAGUE_REGISTRY[leagueId];
			await fs.rm(path.resolve('data/SQL', config.dbFile), { force: true });
		}
	});

	test.after(async () => {
		// Clean up generated data
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
		for (const leagueId of Object.keys(EUROPE_LEAGUE_REGISTRY)) {
			const config = EUROPE_LEAGUE_REGISTRY[leagueId];
			await fs.rm(path.resolve('data/SQL', config.dbFile), { force: true });
		}
	});

	test('should run extraction, transformation, and database load for Europe successfully across per-league databases', async () => {
		const scraper = new EuropeScraper({ competitions: 'euroleague,eurocup,bcl' });

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

		// 4. Query SQLite and verify per-league databases
		// Test EuroLeague database
		const elConfig = EUROPE_LEAGUE_REGISTRY.euroleague;
		const elDb = await initDatabase(elConfig.dbFile.replace('.sqlite', ''), 'euroleague');
		try {
			const elPlayers = elDb.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('euroleague', String(year));
			assert.ok(elPlayers.length > 0, 'Should have player stats for euroleague');
			assert.equal(elPlayers[0].team_city, 'Europe');
			assert.equal(elPlayers[0].league, 'euroleague');

			const elTeams = elDb.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('euroleague', String(year));
			assert.ok(elTeams.length > 0, 'Should have team stats for euroleague');

			const elCompetitions = elDb.prepare('SELECT * FROM competitions').all();
			assert.ok(elCompetitions.some(c => c.id === 'euroleague' && c.name === 'EuroLeague' && c.type === 'continental'));

			const elGames = elDb.prepare('SELECT * FROM games WHERE season_id = ?').all(String(year));
			assert.ok(elGames.length > 0, 'Should have games for euroleague');
			assert.ok(elGames.some(g => g.competition_id === 'euroleague'));
		} finally {
			elDb.close();
		}

		// Test EuroCup database
		const ecConfig = EUROPE_LEAGUE_REGISTRY.eurocup;
		const ecDb = await initDatabase(ecConfig.dbFile.replace('.sqlite', ''), 'eurocup');
		try {
			const ecPlayers = ecDb.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('eurocup', String(year));
			assert.ok(ecPlayers.length > 0, 'Should have player stats for eurocup');
			assert.equal(ecPlayers[0].league, 'eurocup');

			const ecCompetitions = ecDb.prepare('SELECT * FROM competitions').all();
			assert.ok(ecCompetitions.some(c => c.id === 'eurocup' && c.name === 'EuroCup' && c.type === 'continental'));

			const ecGames = ecDb.prepare('SELECT * FROM games WHERE season_id = ?').all(String(year));
			assert.ok(ecGames.some(g => g.competition_id === 'eurocup'));
		} finally {
			ecDb.close();
		}

		// Test BCL database
		const bclConfig = EUROPE_LEAGUE_REGISTRY.basketball_champions_league;
		const bclDb = await initDatabase(bclConfig.dbFile.replace('.sqlite', ''), 'basketball_champions_league');
		try {
			const bclPlayers = bclDb.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('basketball_champions_league', String(year));
			assert.ok(bclPlayers.length > 0, 'Should have player stats for basketball_champions_league');
			assert.equal(bclPlayers[0].league, 'basketball_champions_league');

			const bclCompetitions = bclDb.prepare('SELECT * FROM competitions').all();
			assert.ok(bclCompetitions.some(c => c.id === 'bcl' && c.name === 'Basketball Champions League' && c.type === 'continental'));

			const bclGames = bclDb.prepare('SELECT * FROM games WHERE season_id = ?').all(String(year));
			assert.ok(bclGames.some(g => g.competition_id === 'bcl'));
		} finally {
			bclDb.close();
		}
	});
});