import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { WNBAScraper } from '../src/scrapers/wnba/wnba.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { transformWnbaPbp, parseClockToSeconds } from '../src/scrapers/wnba/pbp/WnbaPbpTransformer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

const mockCdnPbpResponse = {
	game: {
		gameId: "0042300101",
		actions: [
			{
				actionId: 1,
				period: 1,
				clock: "PT10M00.00S",
				actionType: 12, // Period start
				description: "Start of 1st Period",
				scoreHome: "0",
				scoreAway: "0"
			},
			{
				actionId: 2,
				period: 1,
				clock: "PT09M30.00S",
				actionType: 1, // Made Shot
				actionSubtype: 2,
				teamId: "1611661313",
				personId: "10002",
				description: "Ionescu 25' 3PT Jump Shot (3 PTS)",
				scoreHome: "0",
				scoreAway: "3",
				isFieldGoal: 1,
				shotResult: "made",
				xLegacy: 10,
				yLegacy: 20,
				shotDistance: 25
			},
			{
				actionId: 3,
				period: 1,
				clock: "PT08M45.00S",
				actionType: 8, // Substitution
				teamId: "1611661313",
				personId: "10002",
				person2Id: "10003",
				description: "SUB: Vandersloot FOR Ionescu",
				scoreHome: "0",
				scoreAway: "3"
			},
			{
				actionId: 4,
				period: 1,
				clock: "PT00M00.00S",
				actionType: 13, // Period end
				description: "End of 1st Period",
				scoreHome: "0",
				scoreAway: "3"
			}
		]
	}
};

const mockStatsApiPbpResponse = {
	resource: "playbyplay",
	parameters: { GameID: "0042300102" },
	resultSets: [
		{
			name: "PlayByPlay",
			headers: ["GAME_ID", "EVENTNUM", "EVENTMSGTYPE", "EVENTMSGACTIONTYPE", "PERIOD", "WCTIMESTRING", "PCTIMESTRING", "HOMEDESCRIPTION", "NEUTRALDESCRIPTION", "VISITORDESCRIPTION", "SCORE", "SCOREMARGIN", "PLAYER1_ID", "PLAYER1_TEAM_ID", "PLAYER2_ID"],
			rowSet: [
				["0042300102", 1, 12, 0, 1, "7:00 PM", "10:00", null, "Start Period", null, null, null, null, null, null],
				["0042300102", 2, 1, 1, 1, "7:01 PM", "09:15", "Thomas 2' Layup (2 PTS)", null, null, "0 - 2", "2", "10001", "1611661315", null],
				["0042300102", 3, 13, 0, 1, "7:10 PM", "00:00", null, "End Period", null, "0 - 2", "2", null, null, null]
			]
		}
	]
};

let originalFetch;

test.before(() => {
	process.env.NODE_ENV = 'test';
	originalFetch = globalThis.fetch;
});

test.after(() => {
	globalThis.fetch = originalFetch;
});

test.describe('WNBA Play-by-Play Unit Tests', () => {
	test('parseClockToSeconds should accurately parse ISO 8601 duration and standard MM:SS strings', () => {
		assert.equal(parseClockToSeconds('PT10M00.00S', 1), 600);
		assert.equal(parseClockToSeconds('PT08M45.50S', 1), 525.5);
		assert.equal(parseClockToSeconds('08:45', 1), 525);
		assert.equal(parseClockToSeconds('00:00', 1), 0);
	});

	test('transformWnbaPbp should clean CDN Live PBP JSON actions and generate derived 5-on-5 stints', () => {
		const result = transformWnbaPbp('0042300101', mockCdnPbpResponse);

		assert.equal(result.events.length, 4);
		assert.equal(result.events[1].event_type, 1);
		assert.equal(result.events[1].away_score, 3);
		assert.equal(result.events[1].loc_x, 10);
		assert.equal(result.events[1].loc_y, 20);

		assert.equal(result.stints.length, 2);
		assert.equal(result.stints[0].game_id, '0042300101');
		assert.equal(result.stints[0].period, 1);
		assert.equal(result.stints[0].duration_seconds, 75);
	});

	test('transformWnbaPbp should clean Stats API PBP rowSet array and handle scores correctly', () => {
		const result = transformWnbaPbp('0042300102', mockStatsApiPbpResponse);

		assert.equal(result.events.length, 3);
		assert.equal(result.events[1].event_type, 1);
		assert.equal(result.events[1].home_score, 2);
		assert.equal(result.events[1].player_id, '10001');

		assert.equal(result.stints.length, 1);
		assert.equal(result.stints[0].home_pts, 2);
	});

	test('fetchWnbaPbp should normalize 10-prefixed legacy game IDs to standard 00-prefixed format', async () => {
		let fetchedCdnUrl = null;
		globalThis.fetch = async (url) => {
			fetchedCdnUrl = url;
			return {
				ok: true,
				status: 200,
				json: async () => mockCdnPbpResponse
			};
		};

		const harvester = new (await import('../src/scrapers/wnba/harvesters/WnbaPbpHarvester.mjs')).WnbaPbpHarvester();
		await harvester.fetchWnbaPbp('1042100313', '2021');

		assert.equal(fetchedCdnUrl, 'https://cdn.wnba.com/static/json/liveData/playbyplay/playbyplay_0042100313.json');
	});

	test('transformWnbaPbp should parse alternative PBP payload shapes (plays, resultSet, case-insensitive headers)', () => {
		// Test alternative 1: game.plays
		const alt1 = { game: { plays: [{ actionId: 1, period: 1, clock: "10:00", actionType: 12, description: "Start Period" }] } };
		const res1 = transformWnbaPbp('0042200101', alt1);
		assert.equal(res1.events.length, 1);
		assert.equal(res1.events[0].event_type, 12);

		// Test alternative 2: resultSet object with lowercase headers
		const alt2 = {
			resultSet: {
				headers: ["eventNum", "eventMsgType", "period", "pcTimeString", "homedescription", "score"],
				rowSet: [
					[1, 1, 1, "09:00", "3PT Jump Shot", "0 - 3"]
				]
			}
		};
		const res2 = transformWnbaPbp('0042200102', alt2);
		assert.equal(res2.events.length, 1);
		assert.equal(res2.events[0].event_type, 1);
		assert.equal(res2.events[0].away_score, 0);
		assert.equal(res2.events[0].home_score, 3);
	});
});

test.describe('WNBA PBP Pipeline Integration Tests', () => {
	test('Full WNBA PBP Pipeline Execution: Extract -> Transform -> Load -> SQLite Audit', async () => {
		const testLeague = 'wnba_pbp_test';
		const testYear = '2024';

		globalThis.fetch = async (url) => {
			if (url.includes('playbyplay_0042300101.json')) {
				return {
					ok: true,
					status: 200,
					json: async () => mockCdnPbpResponse
				};
			}
			return {
				ok: false,
				status: 404
			};
		};

		const scraper = new WNBAScraper({ boxscoreType: 'pbp' });
		scraper.getSeasonGameSlugs = async function() {
			this.gameSlugs = ['nyl-vs-con-0042300101'];
			return this;
		};

		// 1. Stage 1 Extract
		const extractedGameIds = await extractStage(scraper, testLeague, testYear, { boxscoreType: 'pbp' });
		assert.deepEqual(extractedGameIds, ['0042300101']);

		const rawFilePath = path.resolve(`data/raw/${testLeague}/pbp/${testYear}/0042300101.json`);
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
			const eventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('0042300101');
			assert.equal(eventsCount.count, 4);

			const maxAwayScore = db.prepare('SELECT MAX(away_score) as max_score FROM game_play_by_play WHERE game_id = ?').get('0042300101');
			assert.equal(maxAwayScore.max_score, 3);

			const stintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('0042300101');
			assert.equal(stintsCount.count, 2);
		} finally {
			db.destroy();
			// Cleanup test artifacts
			await fs.rm(path.resolve(`data/raw/${testLeague}`), { recursive: true, force: true });
			await fs.rm(path.resolve(`data/transformed/${testLeague}`), { recursive: true, force: true });
			await fs.rm(path.resolve(`data/SQL/${testLeague.toUpperCase()}.sqlite`), { force: true });
		}
	});
});
