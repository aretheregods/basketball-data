import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { NblScraper } from '../src/scrapers/nbl/NblScraper.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { transformNblPbp, parseFibaClockToSeconds, calculateGameSecondsRemaining } from '../src/scrapers/nbl/pbp/NblPbpTransformer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mockFibaPbpResponse = {
	pbp: [
		{
			actionNumber: 1,
			period: 1,
			gt: "10:00",
			actionType: "period",
			subType: "start",
			text: "Start of 1st Quarter",
			s1: 0,
			s2: 0
		},
		{
			actionNumber: 2,
			period: 1,
			gt: "09:30",
			actionType: "shot",
			subType: "3pt",
			scoring: 1,
			success: 1,
			tno: "MELB",
			personId: "chris-goulding",
			text: "Chris Goulding 3pt Shot Made",
			s1: 3,
			s2: 0,
			x: 12.5,
			y: 25.0,
			distance: 7.25
		},
		{
			actionNumber: 3,
			period: 1,
			gt: "08:45",
			actionType: "substitution",
			tno: "MELB",
			personId: "chris-goulding",
			subPersonId: "shea-ili",
			text: "Substitution: Shea Ili in for Chris Goulding",
			s1: 3,
			s2: 0
		},
		{
			actionNumber: 4,
			period: 1,
			gt: "00:00",
			actionType: "period",
			subType: "end",
			text: "End of 1st Quarter",
			s1: 3,
			s2: 0
		}
	]
};

test.before(async () => {
	process.env.NODE_ENV = 'test';
	await fs.rm(path.resolve(`data/raw/nbl_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/transformed/nbl_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/SQL/NBL_PBP_TEST.sqlite`), { force: true });
});

test.after(async () => {
	await fs.rm(path.resolve(`data/raw/nbl_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/transformed/nbl_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/SQL/NBL_PBP_TEST.sqlite`), { force: true });
});

test.describe('NBL Play-by-Play Unit Tests', () => {
	test('parseFibaClockToSeconds should accurately parse FIBA clock strings and ISO durations', () => {
		assert.equal(parseFibaClockToSeconds('10:00', 1), 600);
		assert.equal(parseFibaClockToSeconds('08:45.5', 1), 525.5);
		assert.equal(parseFibaClockToSeconds('PT08M45.00S', 1), 525);
		assert.equal(parseFibaClockToSeconds('00:00', 1), 0);
	});

	test('calculateGameSecondsRemaining should properly compute FIBA 10-min quarter and OT clocks', () => {
		assert.equal(calculateGameSecondsRemaining(1, 600), 2400); // Q1 10:00 = 1800 + 600
		assert.equal(calculateGameSecondsRemaining(4, 0), 0);     // Q4 00:00 = 0
		assert.equal(calculateGameSecondsRemaining(5, 300), 300); // OT1 05:00 = 300
	});

	test('transformNblPbp should clean raw FIBA LiveStats PBP JSON and generate derived 5-on-5 stints', () => {
		const result = transformNblPbp('melbourne-united-vs-sydney-kings-O2024_10001', mockFibaPbpResponse);

		assert.equal(result.events.length, 4);
		assert.equal(result.events[1].event_type, 'shot');
		assert.equal(result.events[1].home_score, 3);
		assert.equal(result.events[1].loc_x, 12.5);
		assert.equal(result.events[1].loc_y, 25.0);
		assert.equal(result.events[1].game_seconds_remaining, 2370); // 1800 + 570

		assert.equal(result.stints.length, 2);
		assert.equal(result.stints[0].game_id, 'melbourne-united-vs-sydney-kings-O2024_10001');
		assert.equal(result.stints[0].period, 1);
		assert.equal(result.stints[0].duration_seconds, 75);
	});
});

test.describe('NBL PBP Pipeline Integration Tests', () => {
	test('Full NBL PBP Pipeline Execution: Extract -> Transform -> Load -> SQLite Audit', async () => {
		const testLeague = 'nbl_pbp_test';
		const testYear = '2024';

		const scraper = new NblScraper({ boxscoreType: 'pbp' });
		scraper.getSeasonGameSlugs = async function() {
			this.gameSlugs = ['melbourne-united-vs-sydney-kings-O2024_10001'];
			return this;
		};

		// 1. Stage 1 Extract
		const extractedGameIds = await extractStage(scraper, testLeague, testYear, { boxscoreType: 'pbp' });
		assert.deepEqual(extractedGameIds, ['O2024_10001']);

		const rawFilePath = path.resolve(`data/raw/${testLeague}/pbp/${testYear}/O2024_10001.json`);
		const rawExists = await fs.access(rawFilePath).then(() => true).catch(() => false);
		assert.equal(rawExists, true);

		// 2. Stage 2 Transform
		const transformedData = await transformStage(testLeague, testYear, { boxscoreType: 'pbp' });
		assert.equal(transformedData.events.length, 4);
		assert.equal(transformedData.stints.length, 2);

		// 3. Stage 3 Load
		await loadStage(testLeague, testYear, transformedData, { boxscoreType: 'pbp' });

		// 4. Verification & Audit Queries in SQLite
		const db = await initDatabase(testLeague);
		try {
			const eventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('O2024_10001');
			assert.equal(eventsCount.count, 4);

			const maxHomeScore = db.prepare('SELECT MAX(home_score) as max_score FROM game_play_by_play WHERE game_id = ?').get('O2024_10001');
			assert.equal(maxHomeScore.max_score, 3);

			const stintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('O2024_10001');
			assert.equal(stintsCount.count, 2);
		} finally {
			if (db) db.destroy();
		}
	});
});
