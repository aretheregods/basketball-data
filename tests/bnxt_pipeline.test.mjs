import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { BnxtScraper } from '../src/scrapers/europe/BnxtScraper.mjs';
import { BnxtHarvester } from '../src/scrapers/europe/harvesters/BnxtHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('BNXT League Scraper & Pipeline Integration', () => {
	const league = 'europe_bnxt_test';
	const year = '2024';

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/raw/europe/bnxt', year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/raw/europe/bnxt', year), { recursive: true, force: true });
	});

	test('BnxtHarvester should return mock slugs in test mode', async () => {
		const harvester = new BnxtHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-N2024_'), 'Slugs must be formatted with N season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^N2024_\d+$/, 'gameId Segment must match BNXT pattern');
	});

	test('BnxtScraper should return correct unified schema mock data', async () => {
		const scraper = new BnxtScraper();
		const boxscore = await scraper.getUnifiedBoxScore('filou-oostende-vs-spirou-basket-N2024_7161');

		assert.equal(boxscore.gameId, 'filou-oostende-vs-spirou-basket-N2024_7161');
		assert.equal(boxscore.competitionId, 'bnxt');
		assert.equal(boxscore.seasonId, '2024');

		// Home/Away team checks
		assert.equal(boxscore.homeTeam.teamName, 'Filou Oostende');
		assert.equal(boxscore.homeTeam.score, 83);
		assert.ok(boxscore.homeTeam.players.length > 0);

		assert.equal(boxscore.awayTeam.teamName, 'Spirou Basket');
		assert.equal(boxscore.awayTeam.score, 71);
		assert.ok(boxscore.awayTeam.players.length > 0);

		// Player stats checks
		const player = boxscore.homeTeam.players.find(p => p.playerName.includes('Mennes'));
		assert.ok(player);
		assert.equal(player.playerId, 'p-242');
		assert.equal(player.statistics.pts, 9);
		assert.equal(player.statistics.min, '32:00');
	});

	test('EuropeScraper should route gameId prefixed with N to BnxtScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'bnxt' });
		const engine = scraper.getEngineForGame('filou-oostende-vs-spirou-basket-N2024_7161');
		assert.ok(engine instanceof BnxtScraper);
	});

	test('Full BNXT Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'bnxt' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('N2024_7161'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			const mennes = transformed.players.find(p => p.player_name === 'Joppe Mennes');
			assert.ok(mennes);
			assert.equal(mennes.pts, 9);
			assert.equal(mennes.league, 'bnxt');

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('bnxt', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Joppe Mennes'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('bnxt', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'Filou Oostende'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('bnxt', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'N2024_7161'));
			} finally {
				db.close();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
