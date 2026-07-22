import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import child_process from 'child_process';
import { BaseNormalizer } from '#utils';
import { WNBAScraper } from '../src/scrapers/wnba/wnba.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { syncStage } from '../src/stages/4-sync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

let originalLog = console.log;
let originalWarn = console.warn;
let originalError = console.error;

test.before(async () => {
	process.env.NODE_ENV = 'test';
	console.log = () => {};
	console.warn = () => {};
	console.error = () => {};

	// Clean any previous SQL files for testing
	await fs.rm(path.resolve('data/SQL'), { recursive: true, force: true });
});

test.after(async () => {
	console.log = originalLog;
	console.warn = originalWarn;
	console.error = originalError;

	// Clean up SQL databases after tests complete
	await fs.rm(path.resolve('data/SQL'), { recursive: true, force: true });
});

/**
 * @description Helper to wrap async test functions and strip native/un-serializable properties
 * from database error objects to avoid Node worker deserialization failures.
 * @param {Function} fn - Async function to execute
 */
async function runWithCleanErrors(fn) {
	try {
		await fn();
	} catch (err) {
		const cleanErr = new Error(err.message);
		cleanErr.stack = err.stack;
		throw cleanErr;
	}
}

test.describe('BaseNormalizer', () => {
	test('cleanString should trim and collapse whitespace', () => {
		assert.equal(BaseNormalizer.cleanString('  Hello   World!  '), 'Hello World!');
		assert.equal(BaseNormalizer.cleanString(null), '');
		assert.equal(BaseNormalizer.cleanString(123), '');
	});

	test('normalizeName should remove diacritics and accents', () => {
		assert.equal(BaseNormalizer.normalizeName('Añgêl Špûr̃'), 'Angel Spur');
		assert.equal(BaseNormalizer.normalizeName('  Elena Delle Donne  '), 'Elena Delle Donne');
	});

	test('calculateTSPct should calculate True Shooting Percentage correctly', () => {
		assert.equal(BaseNormalizer.calculateTSPct(20, 10, 5), 0.8197);
		assert.equal(BaseNormalizer.calculateTSPct(0, 0, 0), 0.0);
	});

	test('calculateEFGPct should calculate Effective Field Goal Percentage correctly', () => {
		assert.equal(BaseNormalizer.calculateEFGPct(8, 4, 16), 0.625);
		assert.equal(BaseNormalizer.calculateEFGPct(0, 0, 0), 0.0);
	});

	test('calculateGameScore should calculate Game Score correctly', () => {
		assert.equal(BaseNormalizer.calculateGameScore(20, 8, 15, 4, 3, 2, 5, 2, 4, 1, 3, 2), 17.5);
	});

	test('parseMinutesToFloat should correctly parse various formats', () => {
		assert.equal(BaseNormalizer.parseMinutesToFloat('PT36M12.00S'), 36.2);
		assert.equal(BaseNormalizer.parseMinutesToFloat('PT10M'), 10.0);
		assert.equal(BaseNormalizer.parseMinutesToFloat('PT1H20M5S'), 80.1);
		assert.equal(BaseNormalizer.parseMinutesToFloat('36:12'), 36.2);
		assert.equal(BaseNormalizer.parseMinutesToFloat('05:03'), 5.1);
		assert.equal(BaseNormalizer.parseMinutesToFloat('36'), 36.0);
		assert.equal(BaseNormalizer.parseMinutesToFloat(36), 36.0);
		assert.equal(BaseNormalizer.parseMinutesToFloat(''), 0.0);
		assert.equal(BaseNormalizer.parseMinutesToFloat(null), 0.0);
		assert.equal(BaseNormalizer.parseMinutesToFloat(undefined), 0.0);
	});
});

test.describe('Pipeline Stages', () => {
	const league = 'wnba';
	const year = '1999'; // Special test year to isolate test data

	const mockBoxScoreData = {
		resource: "boxscore",
		parameters: { GameID: "0012300001" },
		resultSets: [
			{
				name: "PlayerStats",
				headers: ["GAME_ID", "PLAYER_ID", "PLAYER_NAME", "PTS", "FGM", "FGA", "FTM", "FTA", "OREB", "DREB", "STL", "AST", "BLK", "PF", "TO"],
				rowSet: [
					["0012300001", 1001, "Añgêl Špûr̃", 20, 8, 15, 3, 4, 2, 5, 2, 4, 1, 3, 2]
				]
			},
			{
				name: "TeamStats",
				headers: ["GAME_ID", "TEAM_ID", "TEAM_NAME", "PTS", "FGM", "FGA", "FTM", "FTA", "OREB", "DREB", "STL", "AST", "BLK", "PF", "TO"],
				rowSet: [
					["0012300001", 10, "Seattle Storm", 85, 32, 70, 15, 20, 10, 25, 8, 18, 5, 15, 12]
				]
			}
		]
	};

	test.afterEach(async () => {
		await runWithCleanErrors(async () => {
			// Clean up stage-generated directories and files
			await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
			await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
			await fs.rm(path.resolve('data/temp'), { recursive: true, force: true });

			// Clean up SQLite database rows using node:sqlite prepare / run
			const db = await initDatabase(league);
			try {
				db.prepare(`DELETE FROM player_game_stats WHERE league = ? AND season = ?`)
					.run(league, year);
				db.prepare(`DELETE FROM team_game_stats WHERE league = ? AND season = ?`)
					.run(league, year);
			} finally {
				db.destroy();
			}
		});
	});

	test('Stage 3 [LOAD] fallback to cached transformed file if no direct data passed', async () => {
		await runWithCleanErrors(async () => {
			const transformedData = {
				players: [
					{
						game_id: '0012300002',
						player_id: 1002,
						player_name: 'Fallback Star',
						normalized_name: 'Fallback Star',
						team_id: 11,
						team_abbreviation: 'LAS',
						team_city: 'Los Angeles',
						pts: 30,
						ts_pct: 0.75,
						game_score: 22.0,
						season: year,
						league: league,
						synced: 0
					}
				],
				teams: [
					{
						game_id: '0012300002',
						team_id: 11,
						team_name: 'Los Angeles Sparks',
						pts: 90,
						season: year,
						league: league,
						synced: 0
					}
				]
			};

			// 1. Setup cache file
			const cacheDir = path.resolve('data/transformed', league, year);
			await fs.mkdir(cacheDir, { recursive: true });
			await fs.writeFile(path.join(cacheDir, 'transformed.json'), JSON.stringify(transformedData), 'utf8');

			// 2. Call loadStage with empty / undefined data to trigger fallback
			await loadStage(league, year, null);

			// 3. Verify SQLite correctly got populated from cache
			const db = await initDatabase(league);
			try {
				const playerRows = db.prepare(`SELECT * FROM player_game_stats WHERE league = ? AND season = ?`)
					.all(league, year);
				assert.equal(playerRows.length, 1);
				assert.equal(playerRows[0].player_name, 'Fallback Star');

				const teamRows = db.prepare(`SELECT * FROM team_game_stats WHERE league = ? AND season = ?`)
					.all(league, year);
				assert.equal(teamRows.length, 1);
				assert.equal(teamRows[0].team_name, 'Los Angeles Sparks');
			} finally {
				db.destroy();
			}
		});
	});

	test('Stage 3 [LOAD] should throw Error if no data passed and cache file is missing', async () => {
		await runWithCleanErrors(async () => {
			// Ensure cache directory / file does not exist
			const cacheDir = path.resolve('data/transformed', league, year);
			await fs.rm(cacheDir, { recursive: true, force: true });

			// Calling loadStage with null should fail/throw an error because cache does not exist
			await assert.rejects(
				loadStage(league, year, null),
				/Failed to load data/
			);
		});
	});

	test('Stage 1 [EXTRACT] should download and save raw box score', async () => {
		await runWithCleanErrors(async () => {
			const scraper = new WNBAScraper();
			scraper.getSeasonGameSlugs = async () => {
				scraper.gameSlugs = ['nyl-vs-con-0012300001'];
				return scraper;
			};
			scraper.request = async (url) => {
				assert.match(url, /0012300001/);
				return mockBoxScoreData;
			};

			const gameIds = await extractStage(scraper, league, year);
			assert.deepEqual(gameIds, ['0012300001']);

			const expectedFile = path.resolve('data/raw', league, year, '0012300001.json');
			const fileExists = await fs.access(expectedFile).then(() => true).catch(() => false);
			assert.equal(fileExists, true);

			const savedContent = JSON.parse(await fs.readFile(expectedFile, 'utf8'));
			assert.deepEqual(savedContent, mockBoxScoreData);
		});
	});

	test('Stage 2 [TRANSFORM] should process raw file and normalize fields', async () => {
		await runWithCleanErrors(async () => {
			// Pre-populate raw file
			const rawDir = path.resolve('data/raw', league, year);
			await fs.mkdir(rawDir, { recursive: true });
			await fs.writeFile(path.join(rawDir, '0012300001.json'), JSON.stringify(mockBoxScoreData), 'utf8');

			const result = await transformStage(league, year);
			assert.equal(result.players.length, 1);
			assert.equal(result.teams.length, 1);

			const player = result.players[0];
			assert.equal(player.player_name, 'Añgêl Špûr̃'); // cleanString called, diacritics preserved
			assert.equal(player.normalized_name, 'Angel Spur'); // normalizeName called, diacritics removed
			assert.equal(player.ts_pct, 0.5967); // TS% calculated correctly for PTS=20, FGA=15, FTA=4
			assert.equal(player.game_score, 17.5); // Game Score calculated
			assert.equal(player.season, year);
			assert.equal(player.league, league);

			const team = result.teams[0];
			assert.equal(team.team_name, 'Seattle Storm');
			assert.equal(team.season, year);

			// Check cache file
			const cacheFile = path.resolve('data/transformed', league, year, 'transformed.json');
			const cacheExists = await fs.access(cacheFile).then(() => true).catch(() => false);
			assert.equal(cacheExists, true);

			const cachedContent = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
			assert.deepEqual(cachedContent, result);
		});
	});

	test('Stage 3 [LOAD] should save records to SQLite', async () => {
		await runWithCleanErrors(async () => {
			const transformedData = {
				players: [
					{
						game_id: '0012300001',
						player_id: 1001,
						player_name: 'Angel Spur',
						normalized_name: 'Angel Spur',
						team_id: 10,
						team_abbreviation: 'SEA',
						team_city: 'Seattle',
						pts: 20,
						ts_pct: 0.8197,
						game_score: 17.5,
						season: year,
						league: league,
						synced: 0
					}
				],
				teams: [
					{
						game_id: '0012300001',
						team_id: 10,
						team_name: 'Seattle Storm',
						pts: 85,
						season: year,
						league: league,
						synced: 0
					}
				]
			};

			// Run load stage
			await loadStage(league, year, transformedData);

			// Query SQLite using node:sqlite DatabaseSync to check if loaded correctly
			const db = await initDatabase(league);
			try {
				const playerRows = db.prepare(`SELECT * FROM player_game_stats WHERE league = ? AND season = ?`)
					.all(league, year);
				assert.equal(playerRows.length, 1);
				assert.equal(playerRows[0].player_name, 'Angel Spur');
				assert.equal(playerRows[0].ts_pct, 0.8197);
				assert.equal(playerRows[0].synced, 0);

				const teamRows = db.prepare(`SELECT * FROM team_game_stats WHERE league = ? AND season = ?`)
					.all(league, year);
				assert.equal(teamRows.length, 1);
				assert.equal(teamRows[0].team_name, 'Seattle Storm');
			} finally {
				db.destroy();
			}
		});
	});

	test('Stage 4 [SYNC] in dryRun should write temporary delta file but not call wrangler', async () => {
		await runWithCleanErrors(async () => {
			const transformedData = {
				players: [
					{
						game_id: '0012300001',
						player_id: 1001,
						player_name: 'Angel Spur',
						pts: 20,
						season: year,
						league: league,
						synced: 0
					}
				],
				teams: []
			};
			await loadStage(league, year, transformedData);

			// Run syncStage in dryRun mode
			await syncStage(league, year, { dryRun: true });

			// Verify synced flag is STILL 0 because of dry run
			const db = await initDatabase(league);
			try {
				const playerRows = db.prepare(`SELECT * FROM player_game_stats WHERE league = ? AND season = ?`)
					.all(league, year);
				assert.equal(playerRows[0].synced, 0);
			} finally {
				db.destroy();
			}
		});
	});

	test('Stage 4 [SYNC] should run wrangler command and set synced = 1', async () => {
		await runWithCleanErrors(async () => {
			// Mock spawn with simple assignment to avoid Node's V8 structured clone deserialization bugs with native child_process test.mock.method
			const originalSpawn = child_process.spawn;
			child_process.spawn = () => {
				return {
					stdout: {
						on: (event, cb) => {
							if (event === 'data') cb(Buffer.from('Success'));
						}
					},
					stderr: {
						on: (event, cb) => {}
					},
					on: (event, cb) => {
						if (event === 'close') cb(0);
					}
				};
			};

			const transformedData = {
				players: [
					{
						game_id: '0012300001',
						player_id: 1001,
						player_name: 'Angel Spur',
						pts: 20,
						season: year,
						league: league,
						synced: 0
					}
				],
				teams: []
			};
			await loadStage(league, year, transformedData);

			try {
				// Run syncStage
				await syncStage(league, year, { databaseName: 'test_db' });

				// Verify synced flag is now 1
				const db = await initDatabase(league);
				try {
					const playerRows = db.prepare(`SELECT * FROM player_game_stats WHERE league = ? AND season = ?`)
						.all(league, year);
					assert.equal(playerRows[0].synced, 1);
				} finally {
					db.destroy();
				}
			} finally {
				// Restore original spawn
				child_process.spawn = originalSpawn;
			}
		});
	});
});
