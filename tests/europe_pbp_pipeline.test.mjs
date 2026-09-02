import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { EuroleaguePbpHarvester } from '../src/scrapers/europe/pbp/EuroleaguePbpHarvester.mjs';
import {
	calculateGameSecondsRemaining,
	parseEuroClock,
	transformEuroleaguePbp
} from '../src/scrapers/europe/pbp/EuroleaguePbpTransformer.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { AuditEngine } from '../src/audit/AuditEngine.mjs';

process.env.NODE_ENV = 'test';

test('EuroLeague PBP Clock and Helper Unit Tests', async (t) => {
	await t.test('parseEuroClock should parse clock string MM:SS into remaining period seconds', () => {
		assert.equal(parseEuroClock(null, '10:00'), 600);
		assert.equal(parseEuroClock(null, '08:45'), 525);
		assert.equal(parseEuroClock(null, '00:00'), 0);
	});

	await t.test('calculateGameSecondsRemaining should accurately calculate total game clock for FIBA regulation and OT', () => {
		// Q1 (Period 1): 10:00 remaining -> 3*600 + 600 = 2400
		assert.equal(calculateGameSecondsRemaining(1, 600), 2400);
		// Q4 (Period 4): 02:00 remaining -> 0*600 + 120 = 120
		assert.equal(calculateGameSecondsRemaining(4, 120), 120);
		// OT1 (Period 5): 03:00 remaining -> 180
		assert.equal(calculateGameSecondsRemaining(5, 180), 180);
	});
});

test('EuroLeague PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('EuroleaguePbpHarvester parseGameId should parse game codes and competitions', () => {
		const harvester = new EuroleaguePbpHarvester();
		assert.deepEqual(harvester.parseGameId('realmadrid-vs-panathinaikos-E2024_1'), {
			competition: 'euroleague',
			seasonCode: 'E2024',
			gameCode: '1'
		});
		assert.deepEqual(harvester.parseGameId('matchup-U2024_15'), {
			competition: 'eurocup',
			seasonCode: 'U2024',
			gameCode: '15'
		});
	});

	await t.test('transformEuroleaguePbp should normalize event streams and derive 5-on-5 stints from Rows array', () => {
		const rawPayload = {
			seasonCode: 'E2024',
			pbp: {
				Rows: [
					{
						NUMBEROFPLAY: 1,
						PERIOD: 1,
						MINUTE: 1,
						MARKERTIME: '09:45',
						PLAYTYPE: '2FGM',
						TYPE: 'Layup',
						TEAM: 'RMD',
						PLAYER_ID: 'P001',
						PASSING_PLAYER_ID: 'P002',
						POINTS_A: 2,
						POINTS_B: 0,
						PLAYINFO: 'Layup made'
					},
					{
						NUMBEROFPLAY: 2,
						PERIOD: 1,
						MINUTE: 2,
						MARKERTIME: '09:30',
						PLAYTYPE: 'SUB',
						TYPE: 'IN',
						TEAM: 'PAN',
						PLAYER_ID: 'P003',
						POINTS_A: 2,
						POINTS_B: 0,
						PLAYINFO: 'Sub in'
					}
				]
			},
			points: {
				Rows: [
					{ NUM_ANOT: 1, COORD_X: 15.0, COORD_Y: 20.0, DISTANCE: 3.5 }
				]
			}
		};

		const { events, stints } = transformEuroleaguePbp('E2024_1', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].loc_x, 15.0);
		assert.equal(events[0].loc_y, 20.0);
		assert.equal(events[0].shot_distance, 3.5);
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});

	await t.test('transformEuroleaguePbp should support Quarter-based object payloads (FirstQuarter, SecondQuarter, etc.)', () => {
		const quarterPayload = {
			seasonCode: 'E2021',
			pbp: {
				FirstQuarter: [
					{
						NUMBEROFPLAY: 1,
						MARKERTIME: '09:50',
						MINUTE: 1,
						PLAYTYPE: '2FGM',
						CODETEAM: 'MCO',
						PLAYER_ID: 'P100',
						POINTS_A: 2,
						POINTS_B: 0,
						PLAYINFO: 'Jump Shot Made'
					}
				],
				SecondQuarter: [
					{
						NUMBEROFPLAY: 2,
						MARKERTIME: '08:15',
						MINUTE: 2,
						PLAYTYPE: '3FGM',
						CODETEAM: 'PAN',
						PLAYER_ID: 'P200',
						POINTS_A: 2,
						POINTS_B: 3,
						PLAYINFO: '3PT Shot Made'
					}
				]
			}
		};

		const { events, stints } = transformEuroleaguePbp('E2021_1', quarterPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].period, 1);
		assert.equal(events[0].team_id, 'MCO');
		assert.equal(events[0].player_id, 'P100');
		assert.equal(events[1].period, 2);
		assert.equal(events[1].team_id, 'PAN');
		assert.equal(events[1].player_id, 'P200');

		assert.equal(stints.length, 2);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[1].period, 2);
	});
});

test('Europe PBP Full Pipeline Integration Test', async (t) => {
	const league = 'europe_pbp_test';
	const year = '2024';

	// Setup clean mock scraper
	const scraper = new EuropeScraper({ competitions: 'euroleague', boxscoreType: 'pbp' });
	scraper.pbpHarvester.bypassNetwork = true;
	scraper.getSeasonGameSlugs = async function() {
		this.gameSlugs = ['realmadrid-vs-panathinaikos-E2024_1'];
		return this;
	};

	// Clean test directory and test DB before run
	const testRawDir = path.resolve(`data/raw/${league}/pbp/${year}`);
	const testTransformedDir = path.resolve(`data/transformed/${league}/pbp/${year}`);
	const testDbPath = path.resolve(`data/SQL/${league.toUpperCase()}.sqlite`);

	await fs.rm(testRawDir, { recursive: true, force: true });
	await fs.rm(testTransformedDir, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });

	await t.test('Full Europe PBP Pipeline Execution: Extract -> Transform -> Load -> SQLite Audit', async () => {
		// Stage 1: Extract
		const extractedGameIds = await extractStage(scraper, league, year, { type: 'pbp' });
		assert.equal(extractedGameIds.length, 1);
		assert.equal(extractedGameIds[0], 'E2024_1');

		// Stage 2: Transform
		const transformedData = await transformStage(league, year, { type: 'pbp' });
		assert.ok(transformedData.events.length > 0);
		assert.ok(transformedData.stints.length > 0);

		// Stage 3: Load
		await loadStage(league, year, transformedData, { type: 'pbp' });

		// Stage 4: Direct DB verification
		const db = await initDatabase(league);
		try {
			const eventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('E2024_1');
			assert.equal(eventsCount.count, 2);

			const stintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('E2024_1');
			assert.equal(stintsCount.count, 1);

			// Populate team_game_stats record to test AuditEngine PBP stats query
			db.prepare(`
				INSERT INTO team_game_stats (
					game_id, team_id, team_name, team_abbreviation, team_city, min,
					fgm, fga, fg_pct, fg3m, fg3a, fg3_pct, ftm, fta, ft_pct,
					oreb, dreb, reb, ast, stl, blk, tov, pf, pts, plus_minus,
					ts_pct, efg_pct, season, league, synced
				) VALUES (
					'E2024_1', 'RMD', 'Real Madrid', 'RMD', 'Madrid', '200:00',
					30, 60, 0.5, 10, 25, 0.4, 15, 20, 0.75,
					8, 25, 33, 20, 5, 3, 10, 15, 85, 5,
					0.6, 0.55, '2024', 'europe_pbp_test', 0
				)
			`).run();

			const engine = new AuditEngine(testDbPath);
			const fullAudit = engine.runFullAudit();

			assert.ok(fullAudit.totalPbpEvents > 0);
			assert.ok(fullAudit.totalPbpStints > 0);
		} finally {
			if (db) db.destroy();
		}
	});

	// Cleanup test artifacts
	await fs.rm(testRawDir, { recursive: true, force: true });
	await fs.rm(testTransformedDir, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });
});
