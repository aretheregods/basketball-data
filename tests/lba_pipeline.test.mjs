import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { LbaScraper } from '../src/scrapers/europe/LbaScraper.mjs';
import { LbaHarvester } from '../src/scrapers/europe/harvesters/LbaHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('LBA Italian Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_lba_test';
	const year = '2092'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('LbaHarvester should return mock slugs in test mode', async () => {
		const harvester = new LbaHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2092');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-I2092_'), 'Slugs must be formatted with I season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^I2092_[a-z0-9_]+$/, 'gameId Segment must match LBA pattern');
	});

	test('LbaScraper should return correct unified schema mock data', async () => {
		const scraper = new LbaScraper();
		const boxscore = await scraper.getUnifiedBoxScore('unahotels-reggio-emilia-vs-dolomiti-energia-trentino-I2092_24662');

		assert.equal(boxscore.gameId, 'unahotels-reggio-emilia-vs-dolomiti-energia-trentino-I2092_24662');
		assert.equal(boxscore.competitionId, 'lba');
		assert.equal(boxscore.seasonId, '2092');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'UNAHOTELS Reggio Emilia');
		assert.equal(boxscore.homeTeam.score, 76);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const barford = boxscore.homeTeam.players.find(p => p.playerName.includes('Barford'));
		assert.ok(barford);
		assert.equal(barford.playerId, 'bar-jay-96');
		assert.equal(barford.statistics.pts, 19);
		assert.equal(barford.statistics.min, '31:00');
	});

	test('EuropeScraper should route gameId prefixed with I to LbaScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'lba' });
		const engine = scraper.getEngineForGame('unahotels-reggio-emilia-vs-dolomiti-energia-trentino-I2092_24662');
		assert.ok(engine instanceof LbaScraper);
	});

	test('Full LBA Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'lba' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('I2092_24662'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const barford = transformed.players.find(p => p.player_id === 'jaylen-barford');
			assert.ok(barford);
			assert.equal(barford.team_id, 'reggio-emilia'); // resolved team ID
			assert.equal(barford.pts, 19);
			assert.equal(barford.min, '31'); // "31:00" parses to 31 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('lba', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Jaylen Barford'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('lba', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'UNAHOTELS Reggio Emilia'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('lba', year);
				assert.ok(games.length > 0);
			assert.ok(games.some(g => g.id === 'I2092_24662'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
