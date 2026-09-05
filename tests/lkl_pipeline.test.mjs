import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { LklScraper } from '../src/scrapers/europe/LklScraper.mjs';
import { LklHarvester } from '../src/scrapers/europe/harvesters/LklHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('LKL Lithuanian Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_lkl_test';
	const year = '2024'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('LklHarvester should return mock slugs in test mode', async () => {
		const harvester = new LklHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-K2024_'), 'Slugs must be formatted with K season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^K2024_\d+$/, 'gameId Segment must match LKL pattern');
	});

	test('LklScraper should return correct unified schema mock data', async () => {
		const scraper = new LklScraper();
		const boxscore = await scraper.getUnifiedBoxScore('lietkabelis-vs-neptunas-K2024_11574');

		assert.equal(boxscore.gameId, 'lietkabelis-vs-neptunas-K2024_11574');
		assert.equal(boxscore.competitionId, 'lkl');
		assert.equal(boxscore.seasonId, '2024');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'Lietkabelis');
		assert.equal(boxscore.homeTeam.score, 82);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const bickauskis = boxscore.homeTeam.players.find(p => p.playerName.includes('Bickauskis'));
		assert.ok(bickauskis);
		assert.equal(bickauskis.playerId, 'dovis-bickauskis');
		assert.equal(bickauskis.statistics.pts, 10);
		assert.equal(bickauskis.statistics.min, '21:27');
	});

	test('LklScraper API Parser should correctly parse LKL team names, scores, and player statistics from cache', async () => {
		const sampleBoxscoreObj = {
			gameId: 'lietkabelis-vs-neptunas-K2024_11574',
			competitionId: 'lkl',
			seasonId: '2024',
			gameDate: '2024-06-13',
			homeTeam: {
				teamId: "LIE",
				teamName: "Lietkabelis",
				score: 82,
				statistics: {
					fgm: 30, fga: 62, fg3m: 13, fg3a: 35, ftm: 9, fta: 11,
					oreb: 8, dreb: 14, reb: 25, ast: 19, stl: 3, blk: 5, tov: 10, pf: 25
				},
				players: [
					{
						playerId: "dovis-bickauskis",
						playerName: "Dovis Bickauskis",
						statistics: {
							min: "21:27", pts: 10, fgm: 3, fga: 6, fg3m: 2, fg3a: 5, ftm: 2, fta: 2,
							oreb: 1, dreb: 0, reb: 1, ast: 5, stl: 0, blk: 1, tov: 0, pf: 2, plus_minus: -4
						}
					}
				]
			},
			awayTeam: {
				teamId: "NEP",
				teamName: "Neptūnas",
				score: 91,
				statistics: {
					fgm: 28, fga: 63, fg3m: 11, fg3a: 30, ftm: 24, fta: 27,
					oreb: 17, dreb: 25, reb: 45, ast: 22, stl: 7, blk: 1, tov: 9, pf: 21
				},
				players: [
					{
						playerId: "arnas-velicka",
						playerName: "Arnas Velicka",
						statistics: {
							min: "34:03", pts: 7, fgm: 2, fga: 10, fg3m: 2, fg3a: 7, ftm: 1, fta: 2,
							oreb: 3, dreb: 2, reb: 5, ast: 11, stl: 3, blk: 0, tov: 0, pf: 1, plus_minus: 10
						}
					}
				]
			}
		};

		const scraper = new LklScraper();

		// Setup cached raw HTML file so LklScraper reads from it directly instead of fetching
		const gameId = 'lietkabelis-vs-neptunas-K2024_11574';
		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const jsonCacheDir = path.resolve('data/raw/europe/lkl', String(yearPrefix));
		await fs.mkdir(jsonCacheDir, { recursive: true });
		const jsonCachePath = path.join(jsonCacheDir, `${gameCode}.json`);
		await fs.writeFile(jsonCachePath, JSON.stringify(sampleBoxscoreObj, null, 2), 'utf8');

		try {
			// Temporarily disable test mode bypass to force LklScraper to read cache
			scraper.bypassNetwork = false;

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'lkl');
			assert.equal(boxscore.homeTeam.teamName, 'Lietkabelis');
			assert.equal(boxscore.awayTeam.teamName, 'Neptūnas');
			assert.equal(boxscore.homeTeam.score, 82);
			assert.equal(boxscore.awayTeam.score, 91);
			assert.equal(boxscore.gameDate, '2024-06-13');

			const bick = boxscore.homeTeam.players.find(p => p.playerName === 'Dovis Bickauskis');
			assert.ok(bick, 'Should parse Dovis Bickauskis successfully');
			assert.equal(bick.statistics.pts, 10);
			assert.equal(bick.statistics.min, '21:27');

			const vel = boxscore.awayTeam.players.find(p => p.playerName === 'Arnas Velicka');
			assert.ok(vel, 'Should parse Arnas Velicka successfully');
			assert.equal(vel.statistics.pts, 7);
			assert.equal(vel.statistics.min, '34:03');
		} finally {
			// Restore test mode and clean up
			scraper.bypassNetwork = true;
			await fs.rm(jsonCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with K to LklScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'lkl' });
		const engine = scraper.getEngineForGame('lietkabelis-vs-neptunas-K2024_11574');
		assert.ok(engine instanceof LklScraper);
	});

	test('Full LKL Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'lkl' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('K2024_11574'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const bick = transformed.players.find(p => p.player_id === 'dovis-bickauskis');
			assert.ok(bick);
			assert.equal(bick.team_id, 'lietkabelis'); // resolved team ID
			assert.equal(bick.pts, 10);
			assert.equal(bick.min, '21.5'); // "21:27" parses to 21.5 minutes (21 + 27/60 = 21.45 -> rounds half-up to 21.5)

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('lkl', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Dovis Bickauskis'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('lkl', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'Lietkabelis'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('lkl', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'K2024_11574'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
