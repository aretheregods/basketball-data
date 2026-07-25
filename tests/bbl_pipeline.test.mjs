import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { BblScraper } from '../src/scrapers/europe/BblScraper.mjs';
import { BblHarvester } from '../src/scrapers/europe/harvesters/BblHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('BBL German Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_bbl_test';
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

	test('BblHarvester should return mock slugs in test mode', async () => {
		const harvester = new BblHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2095');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-D2095_'), 'Slugs must be formatted with D season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^D2095_[A-Z0-9_]+$/, 'gameId Segment must match BBL pattern');
	});

	test('BblScraper should return correct unified schema mock data', async () => {
		const scraper = new BblScraper();
		const boxscore = await scraper.getUnifiedBoxScore('fc-bayern-vs-alba-berlin-D2095_48210');

		assert.equal(boxscore.gameId, 'fc-bayern-vs-alba-berlin-D2095_48210');
		assert.equal(boxscore.competitionId, 'bbl');
		assert.equal(boxscore.seasonId, '2095');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'FC Bayern München');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const babb = boxscore.homeTeam.players.find(p => p.playerName.includes('Weiler-Babb'));
		assert.ok(babb);
		assert.equal(babb.playerId, 'nick-weiler-babb');
		assert.equal(babb.statistics.pts, 14);
		assert.equal(babb.statistics.min, '28:15');
	});

	test('BblScraper API Parser should correctly parse BBL team names, scores, and player statistics', async () => {
		const sampleJson = {
			gameId: "48210",
			status: "OFFICIAL",
			scheduledTime: "2095-11-15T16:00:00.000Z",
			homeTeam: {
				id: "486",
				gameStat: {
					points: 85,
					fieldGoalsMade: 30,
					fieldGoalsAttempted: 65,
					threePointersMade: 8,
					threePointersAttempted: 24,
					freeThrowsMade: 17,
					freeThrowsAttempted: 20,
					offensiveRebounds: 10,
					defensiveRebounds: 25,
					totalRebounds: 35,
					assists: 18,
					steals: 8,
					blocks: 3,
					turnovers: 12,
					foulsCommitted: 19,
					seasonTeam: {
						teamId: "486",
						name: "FC Bayern München",
						tlc: "BAY"
					}
				},
				playerStats: [
					{
						secondsPlayed: 1695, // 28:15
						points: 14,
						fieldGoalsMade: 5,
						fieldGoalsAttempted: 10,
						threePointShotsMade: 2,
						threePointShotsAttempted: 5,
						freeThrowsMade: 2,
						freeThrowsAttempted: 2,
						offensiveRebounds: 1,
						defensiveRebounds: 4,
						totalRebounds: 5,
						assists: 6,
						steals: 2,
						blocks: 1,
						turnovers: 2,
						foulsCommitted: 3,
						plusMinus: 8,
						seasonPlayer: {
							id: "nick-weiler-babb",
							firstName: "Nick",
							lastName: "Weiler-Babb"
						}
					}
				]
			},
			guestTeam: {
				id: "413",
				gameStat: {
					points: 78,
					fieldGoalsMade: 28,
					fieldGoalsAttempted: 60,
					threePointShotsMade: 7,
					threePointShotsAttempted: 20,
					freeThrowsMade: 15,
					freeThrowsAttempted: 18,
					offensiveRebounds: 8,
					defensiveRebounds: 22,
					totalRebounds: 30,
					assists: 14,
					steals: 6,
					blocks: 1,
					turnovers: 14,
					foulsCommitted: 20,
					seasonTeam: {
						teamId: "413",
						name: "ALBA Berlin",
						tlc: "ALB"
					}
				},
				playerStats: [
					{
						secondsPlayed: 1530, // 25:30
						points: 12,
						fieldGoalsMade: 4,
						fieldGoalsAttempted: 9,
						threePointShotsMade: 1,
						threePointShotsAttempted: 4,
						freeThrowsMade: 3,
						freeThrowsAttempted: 4,
						offensiveRebounds: 2,
						defensiveRebounds: 3,
						totalRebounds: 5,
						assists: 2,
						steals: 1,
						blocks: 0,
						turnovers: 1,
						foulsCommitted: 2,
						plusMinus: -8,
						seasonPlayer: {
							id: "louis-olinde",
							firstName: "Louis",
							lastName: "Olinde"
						}
					}
				]
			}
		};

		const scraper = new BblScraper();

		// Setup cached raw JSON file so BblScraper reads from it directly instead of fetching
		const gameId = 'fc-bayern-vs-alba-berlin-D2095_48210';
		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const jsonCacheDir = path.resolve('data/raw/europe/bbl', String(yearPrefix));
		await fs.mkdir(jsonCacheDir, { recursive: true });
		const jsonCachePath = path.join(jsonCacheDir, `${gameCode}.json`);
		await fs.writeFile(jsonCachePath, JSON.stringify(sampleJson, null, 2), 'utf8');

		try {
			// Temporarily disable test mode bypass to force BblScraper to use its JSON parser
			scraper.bypassNetwork = false;

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'bbl');
			assert.equal(boxscore.homeTeam.teamName, 'FC Bayern München');
			assert.equal(boxscore.awayTeam.teamName, 'ALBA Berlin');
			assert.equal(boxscore.homeTeam.score, 85);
			assert.equal(boxscore.awayTeam.score, 78);

			const babb = boxscore.homeTeam.players.find(p => p.playerName === 'Nick Weiler-Babb');
			assert.ok(babb, 'Should parse Babb successfully');
			assert.equal(babb.statistics.pts, 14);
			assert.equal(babb.statistics.min, '28:15');
			assert.equal(babb.statistics.fgm, 5);
			assert.equal(babb.statistics.fga, 10);
			assert.equal(babb.statistics.fg3m, 2);
			assert.equal(babb.statistics.fg3a, 5);
			assert.equal(babb.statistics.ftm, 2);
			assert.equal(babb.statistics.fta, 2);
			assert.equal(babb.statistics.reb, 5);
			assert.equal(babb.statistics.ast, 6);
			assert.equal(babb.statistics.stl, 2);
			assert.equal(babb.statistics.blk, 1);
			assert.equal(babb.statistics.tov, 2);
			assert.equal(babb.statistics.pf, 3);

			const olinde = boxscore.awayTeam.players.find(p => p.playerName === 'Louis Olinde');
			assert.ok(olinde, 'Should parse Olinde successfully');
			assert.equal(olinde.statistics.pts, 12);
			assert.equal(olinde.statistics.min, '25:30');
			assert.equal(olinde.statistics.fgm, 4);
			assert.equal(olinde.statistics.fga, 9);
			assert.equal(olinde.statistics.fg3m, 1);
			assert.equal(olinde.statistics.fg3a, 4);
			assert.equal(olinde.statistics.ftm, 3);
			assert.equal(olinde.statistics.fta, 4);
			assert.equal(olinde.statistics.reb, 5);
			assert.equal(olinde.statistics.ast, 2);
			assert.equal(olinde.statistics.stl, 1);
			assert.equal(olinde.statistics.blk, 0);
			assert.equal(olinde.statistics.tov, 1);
			assert.equal(olinde.statistics.pf, 2);
		} finally {
			// Restore test mode
			scraper.bypassNetwork = true;
			await fs.rm(jsonCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with D to BblScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'bbl' });
		const engine = scraper.getEngineForGame('fc-bayern-vs-alba-berlin-D2095_48210');
		assert.ok(engine instanceof BblScraper);
	});

	test('Full BBL Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'bbl' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('D2095_48210'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const babb = transformed.players.find(p => p.player_id === 'nick-weiler-babb');
			assert.ok(babb);
			assert.equal(babb.team_id, 'bayern-munich'); // resolved team ID
			assert.equal(babb.pts, 14);
			assert.equal(babb.min, '28.3'); // "28:15" parses to 28.3 minutes (half-up rounding)

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('bbl', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Nick Weiler-Babb'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('bbl', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'FC Bayern München'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('bbl', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'D2095_48210'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
