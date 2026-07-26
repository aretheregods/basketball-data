import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { IsraeliScraper } from '../src/scrapers/europe/IsraeliScraper.mjs';
import { IsraeliHarvester } from '../src/scrapers/europe/harvesters/IsraeliHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('Israeli Basketball (Winner League) Scraper & Pipeline Integration', () => {
	const league = 'europe_israel_test';
	const year = '2095'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('IsraeliHarvester should return mock slugs in test mode', async () => {
		const harvester = new IsraeliHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2095');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-Y2095_'), 'Slugs must be formatted with Y season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^Y2095_\d+$/, 'gameId Segment must match Israeli pattern');
	});

	test('IsraeliScraper should return correct unified schema mock data', async () => {
		const scraper = new IsraeliScraper();
		const boxscore = await scraper.getUnifiedBoxScore('matchup-Y2095_25147');

		assert.equal(boxscore.gameId, 'matchup-Y2095_25147');
		assert.equal(boxscore.competitionId, 'israel');
		assert.equal(boxscore.seasonId, '2095');

		// Home/Away team checks
		assert.equal(boxscore.homeTeam.teamName, 'Hapoel Afula');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.ok(boxscore.homeTeam.players.length > 0);

		assert.equal(boxscore.awayTeam.teamName, 'Ironi Lati Kiryat Ata');
		assert.equal(boxscore.awayTeam.score, 67);
		assert.ok(boxscore.awayTeam.players.length > 0);

		// Player stats checks
		const player = boxscore.awayTeam.players.find(p => p.playerName.includes('Pruitt'));
		assert.ok(player);
		assert.equal(player.playerId, 'akia-pruitt');
		assert.equal(player.statistics.pts, 12);
		assert.equal(player.statistics.min, '33');
	});

	test('IsraeliScraper HTML Parser should correctly parse team names, scores, and player statistics from basket.co.il cache', async () => {
		const scraper = new IsraeliScraper();
		const gameId = 'ironi-lati-kiryat-ata-vs-hapoel-afula-Y2095_25147';

		// Load real production HTML from basket.co.il saved during exploration
		const testHtmlPath = path.resolve(PROJECT_ROOT, 'test_game_zone.html');
		const testHtml = await fs.readFile(testHtmlPath, 'utf8');

		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const htmlCacheDir = path.resolve('data/raw/europe/israel', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);
		await fs.writeFile(htmlCachePath, testHtml, 'utf8');

		try {
			// Temporarily disable test mode bypass to force IsraeliScraper to parse cache HTML
			scraper.bypassNetwork = false;

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'israel');
			assert.equal(boxscore.homeTeam.teamName, 'Hapoel Afula'); // Note: mapped based on expected vs tables
			assert.equal(boxscore.awayTeam.teamName, 'Ironi Lati Kiryat Ata');
			assert.equal(boxscore.homeTeam.score, 84);
			assert.equal(boxscore.awayTeam.score, 67);
			assert.equal(boxscore.gameDate, '2024-10-06');

			// Player: Akia Pruitt (Kiryat Ata)
			const pruitt = boxscore.awayTeam.players.find(p => p.playerName === 'Akia Pruitt');
			assert.ok(pruitt, 'Should parse Akia Pruitt successfully');
			assert.equal(pruitt.statistics.pts, 12);
			assert.equal(pruitt.statistics.min, '33');
			assert.equal(pruitt.statistics.fgm, 4); // 2/5 2PT + 2/5 3PT = 4 FGM
			assert.equal(pruitt.statistics.fga, 10); // 5 + 5 = 10 FGA
			assert.equal(pruitt.statistics.ftm, 2);
			assert.equal(pruitt.statistics.fta, 3);
			assert.equal(pruitt.statistics.oreb, 0);
			assert.equal(pruitt.statistics.dreb, 4);
			assert.equal(pruitt.statistics.reb, 4);
			assert.equal(pruitt.statistics.ast, 2);
			assert.equal(pruitt.statistics.tov, 0);
			assert.equal(pruitt.statistics.pf, 2);

			// Player: Raz Adam (Kiryat Ata)
			const adam = boxscore.awayTeam.players.find(p => p.playerName === 'Raz Adam');
			assert.ok(adam, 'Should parse Raz Adam successfully');
			assert.equal(adam.statistics.pts, 7);
			assert.equal(adam.statistics.min, '30');
			assert.equal(adam.statistics.fgm, 1);
			assert.equal(adam.statistics.fga, 4);
			assert.equal(adam.statistics.ftm, 4);
			assert.equal(adam.statistics.fta, 4);
			assert.equal(adam.statistics.reb, 5);
			assert.equal(adam.statistics.ast, 4);
			assert.equal(adam.statistics.stl, 0);
			assert.equal(adam.statistics.tov, 4);
			assert.equal(adam.statistics.pf, 2);

		} finally {
			// Restore test mode and clean up
			scraper.bypassNetwork = true;
			await fs.rm(htmlCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with Y to IsraeliScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'israel' });
		const engine = scraper.getEngineForGame('ironi-lati-kiryat-ata-vs-hapoel-afula-Y2095_25147');
		assert.ok(engine instanceof IsraeliScraper);
	});

	test('Full Israel Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'israel' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('Y2095_25147'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const pruitt = transformed.players.find(p => p.player_id === 'akia-pruitt');
			assert.ok(pruitt);
			assert.equal(pruitt.team_id, 'kiryat-ata'); // Resolved via mappings
			assert.equal(pruitt.pts, 12);
			assert.equal(pruitt.min, '33');

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('israel', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Akia Pruitt'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('israel', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'Ironi Lati Kiryat Ata'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('israel', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'Y2095_25147'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
