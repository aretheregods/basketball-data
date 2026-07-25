import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { LnbScraper } from '../src/scrapers/europe/LnbScraper.mjs';
import { LnbHarvester } from '../src/scrapers/europe/harvesters/LnbHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('LNB French Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_lnb_test';
	const year = '2093'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('LnbHarvester should return mock slugs in test mode', async () => {
		const harvester = new LnbHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2093');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-L2093_'), 'Slugs must be formatted with L season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^L2093_[a-z0-9_]+$/, 'gameId Segment must match LNB pattern');
	});

	test('LnbScraper should return correct unified schema mock data', async () => {
		const scraper = new LnbScraper();
		const boxscore = await scraper.getUnifiedBoxScore('L2093_2020_09_26_limoges');

		assert.equal(boxscore.gameId, 'L2093_2020_09_26_limoges');
		assert.equal(boxscore.competitionId, 'lnb');
		assert.equal(boxscore.seasonId, '2093');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'LDLC ASVEL');
		assert.equal(boxscore.homeTeam.score, 88);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const okobo = boxscore.homeTeam.players.find(p => p.playerName.includes('Okobo'));
		assert.ok(okobo);
		assert.equal(okobo.playerId, 'elie-okobo');
		assert.equal(okobo.statistics.pts, 18);
		assert.equal(okobo.statistics.min, '18:05');
	});

	test('EuropeScraper should route gameId prefixed with L to LnbScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'lnb' });
		const engine = scraper.getEngineForGame('L2093_2020_09_26_limoges');
		assert.ok(engine instanceof LnbScraper);
	});

	test('Full LNB Pipeline Integration: Extract -> Transform -> Load', async () => {
		const scraper = new EuropeScraper({ competitions: 'lnb' });

		// 1. STAGE 1: Extract
		const gameIds = await extractStage(scraper, league, year);
		assert.ok(gameIds.length > 0);
		assert.ok(gameIds.includes('L2093_2020_09_26_limoges'));

		// 2. STAGE 2: Transform
		const transformed = await transformStage(league, year);
		assert.ok(transformed.players.length > 0);
		assert.ok(transformed.teams.length > 0);

		// Assert transformed records
		const okobo = transformed.players.find(p => p.player_id === 'elie-okobo');
		assert.ok(okobo);
		assert.equal(okobo.team_id, 'asvel-lyon-villeurbanne'); // resolved team ID
		assert.equal(okobo.pts, 18);
		assert.equal(okobo.min, '18.1'); // "18:05" parses to 18.1 minutes

		// 3. STAGE 3: Load
		await loadStage(league, year, transformed);

		// 4. Verify in Database
		const db = await initDatabase(league);
		try {
			const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('lnb', year);
			assert.ok(playerStats.length > 0);
			assert.ok(playerStats.some(p => p.player_name === 'Élie Okobo'));

			const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('lnb', year);
			assert.ok(teamStats.length > 0);
			assert.ok(teamStats.some(t => t.team_name === 'LDLC ASVEL'));

			const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('lnb', year);
			assert.ok(games.length > 0);
			assert.ok(games.some(g => g.id === 'L2093_2020_09_26_limoges'));
		} finally {
			db.destroy();
		}
	});
});
