import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { NBAScraper } from '../src/scrapers/nba/nba.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { transformNbaPbp, parseClockToSeconds, calculateGameSecondsRemaining } from '../src/scrapers/nba/pbp/NbaPbpTransformer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mockCdnPbpResponse = {
	game: {
		gameId: "0022300001",
		actions: [
			{
				actionId: 1,
				period: 1,
				clock: "PT12M00.00S",
				actionType: 12, // Period start
				description: "Start of 1st Period",
				scoreHome: "0",
				scoreAway: "0"
			},
			{
				actionId: 2,
				period: 1,
				clock: "PT11M30.00S",
				actionType: 1, // Made Shot
				actionSubtype: 2,
				teamId: "1610612738",
				personId: "203935",
				description: "Tatum 26' 3PT Jump Shot (3 PTS)",
				scoreHome: "3",
				scoreAway: "0",
				isFieldGoal: 1,
				shotResult: "made",
				xLegacy: 15,
				yLegacy: 25,
				shotDistance: 26
			},
			{
				actionId: 3,
				period: 1,
				clock: "PT10M15.00S",
				actionType: 8, // Substitution
				teamId: "1610612738",
				personId: "203935",
				person2Id: "1628369",
				description: "SUB: White FOR Tatum",
				scoreHome: "3",
				scoreAway: "0"
			},
			{
				actionId: 4,
				period: 1,
				clock: "PT00M00.00S",
				actionType: 13, // Period end
				description: "End of 1st Period",
				scoreHome: "3",
				scoreAway: "0"
			}
		]
	}
};

const mockStatsApiPbpResponse = {
	resource: "playbyplay",
	parameters: { GameID: "0022300002" },
	resultSets: [
		{
			name: "PlayByPlay",
			headers: ["GAME_ID", "EVENTNUM", "EVENTMSGTYPE", "EVENTMSGACTIONTYPE", "PERIOD", "WCTIMESTRING", "PCTIMESTRING", "HOMEDESCRIPTION", "NEUTRALDESCRIPTION", "VISITORDESCRIPTION", "SCORE", "SCOREMARGIN", "PLAYER1_ID", "PLAYER1_TEAM_ID", "PLAYER2_ID"],
			rowSet: [
				["0022300002", 1, 12, 0, 1, "7:00 PM", "12:00", null, "Start Period", null, null, null, null, null, null],
				["0022300002", 2, 1, 1, 1, "7:01 PM", "11:15", "Jokic 2' Layup (2 PTS)", null, null, "2 - 0", "2", "203999", "1610612743", null],
				["0022300002", 3, 13, 0, 1, "7:12 PM", "00:00", null, "End Period", null, "2 - 0", "2", null, null, null]
			]
		}
	]
};

let originalFetch;

test.before(async () => {
	process.env.NODE_ENV = 'test';
	originalFetch = globalThis.fetch;
	await fs.rm(path.resolve(`data/raw/nba_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/transformed/nba_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/SQL/NBA_PBP_TEST.sqlite`), { force: true });
});

test.after(async () => {
	globalThis.fetch = originalFetch;
	await fs.rm(path.resolve(`data/raw/nba_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/transformed/nba_pbp_test`), { recursive: true, force: true });
	await fs.rm(path.resolve(`data/SQL/NBA_PBP_TEST.sqlite`), { force: true });
});

test.describe('NBA Play-by-Play Unit Tests', () => {
	test('parseClockToSeconds and calculateGameSecondsRemaining should accurately handle 12-minute quarters and OT', () => {
		// Period 1
		assert.equal(parseClockToSeconds('PT12M00.00S', 1), 720);
		assert.equal(calculateGameSecondsRemaining(1, 720), 2880); // (4-1)*720 + 720 = 2880
		assert.equal(parseClockToSeconds('PT11M42.50S', 1), 702.5);
		assert.equal(calculateGameSecondsRemaining(1, 702.5), 2862.5);

		// Period 4
		assert.equal(parseClockToSeconds('05:30', 4), 330);
		assert.equal(calculateGameSecondsRemaining(4, 330), 330);

		// Overtime (Period 5)
		assert.equal(parseClockToSeconds('05:00', 5), 300);
		assert.equal(calculateGameSecondsRemaining(5, 300), 300);
	});

	test('transformNbaPbp should clean CDN Live PBP JSON actions and generate derived 5-on-5 stints', () => {
		const result = transformNbaPbp('0022300001', mockCdnPbpResponse);

		assert.equal(result.events.length, 4);
		assert.equal(result.events[1].event_type, 1);
		assert.equal(result.events[1].home_score, 3);
		assert.equal(result.events[1].game_seconds_remaining, 2850); // Period 1 at 11:30 = 2850s total game remaining
		assert.equal(result.events[1].loc_x, 15);
		assert.equal(result.events[1].loc_y, 25);

		assert.equal(result.stints.length, 2);
		assert.equal(result.stints[0].game_id, '0022300001');
		assert.equal(result.stints[0].period, 1);
		assert.equal(result.stints[0].duration_seconds, 105); // 12:00 to 10:15
	});

	test('transformNbaPbp should clean Stats API PBP rowSet array and handle scores correctly', () => {
		const result = transformNbaPbp('0022300002', mockStatsApiPbpResponse);

		assert.equal(result.events.length, 3);
		assert.equal(result.events[1].event_type, 1);
		assert.equal(result.events[1].away_score, 2);
		assert.equal(result.events[1].home_score, 0);
		assert.equal(result.events[1].player_id, '203999');

		assert.equal(result.stints.length, 1);
		assert.equal(result.stints[0].away_pts, 2);
	});

	test('fetchNbaPbp should fetch from CDN Live endpoint', async () => {
		let fetchedUrl = null;
		const prevFetch = globalThis.fetch;
		try {
			globalThis.fetch = async (url) => {
				fetchedUrl = url;
				return {
					ok: true,
					status: 200,
					json: async () => mockCdnPbpResponse
				};
			};

			const harvester = new (await import('../src/scrapers/nba/harvesters/NbaPbpHarvester.mjs')).NbaPbpHarvester();
			const payload = await harvester.fetchNbaPbp('0022300001', '2023');

			assert.equal(fetchedUrl, 'https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_0022300001.json');
			assert.ok(payload);
		} finally {
			globalThis.fetch = prevFetch;
		}
	});
});

test.describe('NBA PBP Pipeline Integration Tests', () => {
	test('Full NBA PBP Pipeline Execution: Extract -> Transform -> Load -> SQLite Audit', async () => {
		const testLeague = 'nba_pbp_test';
		const testYear = '2024';

		const prevFetch = globalThis.fetch;
		try {
			globalThis.fetch = async (url) => {
				if (url.includes('playbyplay_0022300001.json')) {
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

			const scraper = new NBAScraper({ boxscoreType: 'pbp' });
		scraper.getSeasonGameSlugs = async function() {
			this.gameSlugs = ['bos-vs-nyk-0022300001'];
			return this;
		};

		// 1. Stage 1 Extract
		const extractedGameIds = await extractStage(scraper, testLeague, testYear, { boxscoreType: 'pbp' });
		assert.deepEqual(extractedGameIds, ['0022300001']);

		const rawFilePath = path.resolve(`data/raw/${testLeague}/pbp/${testYear}/0022300001.json`);
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
			const eventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('0022300001');
			assert.equal(eventsCount.count, 4);

			const maxHomeScore = db.prepare('SELECT MAX(home_score) as max_score FROM game_play_by_play WHERE game_id = ?').get('0022300001');
			assert.equal(maxHomeScore.max_score, 3);

			const stintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('0022300001');
			assert.equal(stintsCount.count, 2);
			} finally {
				if (db) db.destroy();
			}
		} finally {
			globalThis.fetch = prevFetch;
		}
	});
});
