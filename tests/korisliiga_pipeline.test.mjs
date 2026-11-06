import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { KorisliigaScraper } from '../src/scrapers/europe/KorisliigaScraper.mjs';
import { KorisliigaHarvester } from '../src/scrapers/europe/harvesters/KorisliigaHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Finnish Korisliiga Scraper & Pipeline Integration', () => {
	const league = 'europe_korisliiga_test';
	const year = '2024';

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/raw/europe/korisliiga', year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/raw/europe/korisliiga', year), { recursive: true, force: true });
	});

	test('KorisliigaHarvester should return mock slugs in test mode', async () => {
		const harvester = new KorisliigaHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-F2024_'), 'Slugs must be formatted with F season prefix segment');
		const sampleGameId = slugs[0].match(/F\d{4}_.+$/)[0];
		assert.match(sampleGameId, /^F2024_[a-f0-9-]+$/, 'gameId Segment must match Korisliiga pattern');
	});

	test('KorisliigaScraper should return correct unified schema mock data', async () => {
		const scraper = new KorisliigaScraper();
		const boxscore = await scraper.getUnifiedBoxScore('tampereen-pyrinto-vs-kataja-basket-F2024_431de40c-bebb-5f53-813d-66c80842ff20');

		assert.equal(boxscore.gameId, 'tampereen-pyrinto-vs-kataja-basket-F2024_431de40c-bebb-5f53-813d-66c80842ff20');
		assert.equal(boxscore.competitionId, 'korisliiga');
		assert.equal(boxscore.seasonId, '2024');

		// Home/Away team checks
		assert.equal(boxscore.homeTeam.teamName, 'Tampereen Pyrintö');
		assert.equal(boxscore.homeTeam.score, 66);
		assert.ok(boxscore.homeTeam.players.length > 0);

		assert.equal(boxscore.awayTeam.teamName, 'Kataja Basket');
		assert.equal(boxscore.awayTeam.score, 100);
		assert.ok(boxscore.awayTeam.players.length > 0);

		// Player stats checks
		const player = boxscore.homeTeam.players.find(p => p.playerName.includes('Palmi'));
		assert.ok(player);
		assert.equal(player.playerId, 'topias-palmi');
		assert.equal(player.statistics.pts, 22);
		assert.equal(player.statistics.min, '29:09');
	});

	test('EuropeScraper should route gameId prefixed with F to KorisliigaScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'korisliiga' });
		const engine = scraper.getEngineForGame('tampereen-pyrinto-vs-kataja-basket-F2024_431de40c-bebb-5f53-813d-66c80842ff20');
		assert.ok(engine instanceof KorisliigaScraper);
	});

	test('Full Korisliiga Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'korisliiga' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.some(id => id.startsWith('F2024_')));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			const palmi = transformed.players.find(p => p.player_name === 'Topias Palmi');
			assert.ok(palmi);
			assert.equal(palmi.pts, 22);
			assert.equal(palmi.league, 'korisliiga');

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('korisliiga', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Topias Palmi'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('korisliiga', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'Tampereen Pyrintö'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('korisliiga', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id.includes('F2024_')));
			} finally {
				db.close();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
