process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { BLeagueScraper } from '../src/scrapers/bleague/BLeagueScraper.mjs';
import { CbaScraper } from '../src/scrapers/cba/CbaScraper.mjs';
import {
	transformBLeaguePbp,
	parseBLeagueClockToSeconds,
	calculateGameSecondsRemaining,
	parseBLeagueScore,
	BLEAGUE_ACTION_TYPES,
	BLEAGUE_ADMIN_EVENT_TYPES
} from '../src/scrapers/bleague/pbp/BLeaguePbpTransformer.mjs';
import { isPbpSupported, PBP_SUPPORTED_LEAGUES } from '../src/utils/pbp_support.mjs';
import { assertPbpSupported } from '#utils';
import { validateSchema } from '../src/utils/schema_validator.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const league = 'bleague_pbp_test';
const year = '2024';
const game1 = 'BLEAGUE2024_20001';
const game2 = 'BLEAGUE2024_20002';

const testRawDir = path.resolve(`data/raw/${league}/pbp/${year}`);
const testTransformedRoot = path.resolve(`data/transformed/${league}`);
const testDbPath = path.resolve(`data/SQL/${league.toUpperCase()}.sqlite`);
const cbaPbpDir = path.resolve('data/raw/cba/pbp');

/**
 * @description Runs `run.js` in a child process and captures its full output.
 * `NODE_ENV=test` is forwarded so a broken guard degrades to mock data instead of real requests.
 * @param {string[]} args - CLI arguments passed after `run.js`
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} Exit code and output streams
 */
function runCli(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['run.js', ...args], {
			cwd: PROJECT_ROOT,
			env: { ...process.env, NODE_ENV: 'test' }
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('error', reject);
		child.on('close', code => resolve({ code, stdout, stderr }));
	});
}

/**
 * @description Builds one official-style play row with the feed's ragged defaults applied.
 * @param {Record<string, any>} [overrides={}] - Row specific field overrides
 * @returns {Record<string, any>} Raw play row
 */
function makeRow(overrides = {}) {
	return {
		Period: 1,
		No: 1,
		RestTime: '10:00',
		Score: '0-0',
		ActionCD1: 80,
		ActionCD2: null,
		ActionCD3: null,
		TeamID: null,
		PlayerID1: null,
		PlayText: '',
		...overrides
	};
}

test.before(async () => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('NODE_TEST_') || key === 'NODE_CHANNEL_FD') {
			delete process.env[key];
		}
	}
	await fs.rm(path.resolve(`data/raw/${league}`), { recursive: true, force: true });
	await fs.rm(testTransformedRoot, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });
});

test.after(async () => {
	await fs.rm(path.resolve(`data/raw/${league}`), { recursive: true, force: true });
	await fs.rm(testTransformedRoot, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });
});

test.describe('B.League PBP Unit Tests', () => {
	test('BLEAGUE_ACTION_TYPES should map official ActionCD1 codes to standard event types', () => {
		assert.equal(BLEAGUE_ACTION_TYPES[1], '3FGM');
		assert.equal(BLEAGUE_ACTION_TYPES[2], '3FGA');
		assert.equal(BLEAGUE_ACTION_TYPES[4], '2FGM');
		assert.equal(BLEAGUE_ACTION_TYPES[6], '2FGA');
		assert.equal(BLEAGUE_ACTION_TYPES[7], 'FTM');
		assert.equal(BLEAGUE_ACTION_TYPES[8], 'FTA');
		assert.equal(BLEAGUE_ACTION_TYPES[10], 'ORB');
		assert.equal(BLEAGUE_ACTION_TYPES[12], 'AST');
		assert.equal(BLEAGUE_ACTION_TYPES[13], 'TOV');
		assert.equal(BLEAGUE_ACTION_TYPES[16], 'BASKET_COUNT');
		assert.equal(BLEAGUE_ACTION_TYPES[17], 'TEAM_TURNOVER');
		assert.equal(BLEAGUE_ACTION_TYPES[20], 'FOUL_COACH_TECHNICAL');
		assert.equal(BLEAGUE_ACTION_TYPES[26], 'FOUL_DISQUALIFYING');
		assert.equal(BLEAGUE_ACTION_TYPES[93], 'FOUL_FLAGRANT');
		assert.equal(BLEAGUE_ACTION_TYPES[94], 'FOUL_DISRUPTIVE');
		assert.equal(BLEAGUE_ACTION_TYPES[86], 'SUB_IN');
		assert.equal(BLEAGUE_ACTION_TYPES[87], 'SUB_OUT');
		assert.equal(BLEAGUE_ACTION_TYPES[88], 'TIMEOUT');
		assert.equal(BLEAGUE_ACTION_TYPES[999], undefined);

		for (const admin of ['GAME_START', 'GAME_END', 'PERIOD_START', 'PERIOD_END', 'CLOCK_START', 'CLOCK_STOP', 'SUB_IN', 'SUB_OUT', 'TIMEOUT']) {
			assert.ok(BLEAGUE_ADMIN_EVENT_TYPES.has(admin), `${admin} should be administrative`);
		}
		assert.ok(!BLEAGUE_ADMIN_EVENT_TYPES.has('3FGM'));
		assert.ok(!BLEAGUE_ADMIN_EVENT_TYPES.has('BASKET_COUNT'));
	});

	test('parseBLeagueClockToSeconds should parse M:SS/MM:SS clocks into period seconds', () => {
		assert.equal(parseBLeagueClockToSeconds('10:00'), 600);
		assert.equal(parseBLeagueClockToSeconds('9:45'), 585);
		assert.equal(parseBLeagueClockToSeconds('05:25'), 325);
		assert.equal(parseBLeagueClockToSeconds('8:46.5'), 526.5);
		assert.equal(parseBLeagueClockToSeconds('0:00'), 0);
		assert.equal(parseBLeagueClockToSeconds(45), 45);
		assert.equal(parseBLeagueClockToSeconds(null), 0);
		assert.equal(parseBLeagueClockToSeconds(undefined), 0);
		assert.equal(parseBLeagueClockToSeconds(''), 0);
		assert.equal(parseBLeagueClockToSeconds('abc'), 0);
		assert.equal(parseBLeagueClockToSeconds(NaN), 0);
	});

	test('calculateGameSecondsRemaining should count down regulation quarters and report OT clocks', () => {
		assert.equal(calculateGameSecondsRemaining(1, 600), 2400);
		assert.equal(calculateGameSecondsRemaining(2, 600), 1800);
		assert.equal(calculateGameSecondsRemaining(4, 0), 0);
		assert.equal(calculateGameSecondsRemaining(5, 300), 300);
		assert.equal(calculateGameSecondsRemaining(7, 120), 120);
	});

	test('parseBLeagueScore should parse post-action home-away score strings', () => {
		assert.deepEqual(parseBLeagueScore('42-56'), { home: 42, away: 56 });
		assert.deepEqual(parseBLeagueScore('0-0'), { home: 0, away: 0 });
		assert.deepEqual(parseBLeagueScore('82-90'), { home: 82, away: 90 });
		assert.equal(parseBLeagueScore(null), null);
		assert.equal(parseBLeagueScore(12), null);
		assert.equal(parseBLeagueScore('82'), null);
		assert.equal(parseBLeagueScore('1-2-3'), null);
		assert.equal(parseBLeagueScore('x-y'), null);
	});

	test('transformBLeaguePbp should emit every row with string event types, assist links and shot coordinates', () => {
		const payload = new BLeagueScraper().getMockPbpPayload(game1);
		const { events, stints } = transformBLeaguePbp(game1, payload, 'BLEAGUE2024');

		assert.equal(events.length, 39);
		assert.equal(stints.length, 3);

		// Game start row: administrative, no score, trimmed description.
		assert.equal(events[0].event_id, `${game1}_1000_0`);
		assert.equal(events[0].event_type, 'GAME_START');
		assert.equal(events[0].home_score, 0);
		assert.equal(events[0].away_score, 0);
		assert.equal(events[0].is_scoring_play, 0);
		assert.equal(events[0].competition_id, 'BLEAGUE2024');
		assert.equal(events[0].description, '試合開始');

		// Starter substitution row carries a null Score: the running score must carry forward.
		assert.equal(events[1].event_type, 'SUB_IN');
		assert.equal(events[1].team_id, '9001');
		assert.equal(events[1].player_id, '9101');
		assert.equal(events[1].home_score, 0);
		assert.equal(events[1].shot_distance, null);

		// Made three: score moves, coordinates pass through raw, distance stays null (feed has none).
		assert.equal(events[13].event_type, '3FGM');
		assert.equal(events[13].home_score, 3);
		assert.equal(events[13].is_scoring_play, 1);
		assert.equal(events[13].game_seconds_remaining, 2370);
		assert.equal(events[13].loc_x, 75.5);
		assert.equal(events[13].loc_y, 25.0);
		assert.equal(events[13].shot_distance, null);
		assert.equal(events[13].description, '#1 山田 3Pシュート○  ジャンプショット');

		// The assist row immediately after the made basket credits that shooter (one-shot link).
		assert.equal(events[14].event_type, 'AST');
		assert.equal(events[14].secondary_player_id, '9101');

		// Sub-code composites: CD2 only -> "30:" / "35:".
		assert.equal(events[19].event_type, 'FOUL_PERSONAL');
		assert.equal(events[19].sub_type, '30:');
		assert.equal(events[21].event_type, 'FTM');
		assert.equal(events[21].sub_type, '35:');
		assert.equal(events[21].is_scoring_play, 1);

		// BASKET_COUNT confirms a made basket after a shooting foul but never moves the score.
		assert.equal(events[20].event_type, 'BASKET_COUNT');
		assert.equal(events[20].home_score, 5);
		assert.equal(events[20].is_scoring_play, 0);

		// An assist from the opposing backcourt must not credit the away shooter.
		assert.equal(events[34].event_type, '3FGM');
		assert.equal(events[34].team_id, '9002');
		assert.equal(events[35].event_type, 'AST');
		assert.equal(events[35].team_id, '9001');
		assert.equal(events[35].secondary_player_id, null);

		// Final row matches the Game header scores.
		assert.equal(events[38].event_type, 'GAME_END');
		assert.equal(events[38].home_score, 12);
		assert.equal(events[38].away_score, 9);
		assert.equal(events[38].is_scoring_play, 0);
		assert.equal(payload.Game.HomeTeamScore, 12);
		assert.equal(payload.Game.AwayTeamScore, 9);

		for (const event of events) {
			assert.equal(typeof event.event_type, 'string');
			assert.equal(event.shot_distance, null);
			assert.equal(event.game_id, game1);
			assert.equal(event.competition_id, 'BLEAGUE2024');
			assert.ok(Number.isInteger(event.home_score) && Number.isInteger(event.away_score));
			assert.ok(['FOUL_PERSONAL'].includes(event.event_type) || event.sub_type === null || typeof event.sub_type === 'string');
		}
	});

	test('transformBLeaguePbp should split stints on substitution runs and period boundaries with pre-sub lineups', () => {
		const payload = new BLeagueScraper().getMockPbpPayload(game1);
		const { stints } = transformBLeaguePbp(game1, payload, 'BLEAGUE2024');

		assert.equal(stints.length, 3);

		// Stint 1: guarded game-start interval was discarded, so this is the opening stint
		// (10:00 -> substitution at 8:45) with the PRE-substitution starting lineups.
		assert.equal(stints[0].stint_id, `${game1}_stint_1_1`);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].start_clock, '10:00');
		assert.equal(stints[0].end_clock, '8:45');
		assert.equal(stints[0].duration_seconds, 75);
		assert.deepEqual(JSON.parse(stints[0].home_lineup_hash), ['9101', '9102', '9103', '9104', '9105']);
		assert.deepEqual(JSON.parse(stints[0].away_lineup_hash), ['9201', '9202', '9203', '9204', '9205']);
		assert.equal(stints[0].home_pts, 6);
		assert.equal(stints[0].away_pts, 0);
		// 3 FGA + 0.44 * 2 FTA + 1 TOV = 4.88 -> 4.9
		assert.equal(stints[0].possessions, 4.9);
		assert.equal(stints[0].competition_id, 'BLEAGUE2024');

		// Stint 2: administrative rows only (sub -> clock stop -> period end). It is emitted
		// because the lineup is non-empty, but contributes no possessions.
		assert.equal(stints[1].stint_id, `${game1}_stint_1_2`);
		assert.equal(stints[1].start_clock, '8:45');
		assert.equal(stints[1].end_clock, '0:00');
		assert.equal(stints[1].duration_seconds, 525);
		assert.deepEqual(JSON.parse(stints[1].home_lineup_hash), ['9101', '9102', '9103', '9104', '9106']);
		assert.equal(stints[1].home_pts, 0);
		assert.equal(stints[1].possessions, 0);

		// Stint 3: period 2 restarts the stint index and covers the whole quarter to EOF.
		assert.equal(stints[2].stint_id, `${game1}_stint_2_1`);
		assert.equal(stints[2].period, 2);
		assert.equal(stints[2].start_clock, '10:00');
		assert.equal(stints[2].end_clock, '0:00');
		assert.equal(stints[2].duration_seconds, 600);
		assert.deepEqual(JSON.parse(stints[2].home_lineup_hash), ['9101', '9102', '9103', '9104', '9105']);
		assert.equal(stints[2].home_pts, 6);
		assert.equal(stints[2].away_pts, 9);
		// 3 FGA + 0.44 * 1 FTA = 3.44 -> 3.4
		assert.equal(stints[2].possessions, 3.4);

		// The degenerate pre-lineup interval at game start must never be emitted.
		for (const stint of stints) {
			assert.ok(JSON.parse(stint.home_lineup_hash).length > 0 || JSON.parse(stint.away_lineup_hash).length > 0);
		}
	});

	test('transformBLeaguePbp should resolve sides through the Game header when HomeAway is absent', () => {
		const payload = {
			Game: { HomeTeamID: 'A', AwayTeamID: 'B' },
			PlayByPlays: [
				makeRow({ No: 1, ActionCD1: 80 }),
				// No HomeAway: side must resolve from TeamID vs Game.HomeTeamID.
				makeRow({ No: 2, ActionCD1: 86, TeamID: 'A', PlayerID1: 'P1', Score: null }),
				makeRow({ No: 3, ActionCD1: 1, TeamID: 'A', PlayerID1: 'P1', RestTime: '9:00', Score: '3-0' }),
				makeRow({ No: 4, ActionCD1: 12, TeamID: 'A', PlayerID1: 'P2', RestTime: '8:58', Score: '3-0' }),
				// Second consecutive assist row: the link is single-use, so it resolves to null.
				makeRow({ No: 5, ActionCD1: 12, TeamID: 'A', PlayerID1: 'P3', RestTime: '8:56', Score: '3-0' }),
				makeRow({ No: 6, ActionCD1: 81, RestTime: '0:00', Score: '3-0' })
			]
		};
		const { events, stints } = transformBLeaguePbp('BLEAGUE2024_29999', payload, 'BLEAGUE2024');

		assert.equal(events.length, 6);
		assert.equal(events[3].secondary_player_id, 'P1');
		assert.equal(events[4].secondary_player_id, null);

		// Only the post-substitution stint survives: the game-start interval had an empty
		// lineup and no play when the substitution run closed it.
		assert.equal(stints.length, 1);
		assert.deepEqual(JSON.parse(stints[0].home_lineup_hash), ['P1']);
		assert.equal(stints[0].possessions, 1);
	});

	test('transformBLeaguePbp should flag made shots as scoring even when the feed omits the score', () => {
		const payload = {
			Game: { HomeTeamID: 'A', AwayTeamID: 'B' },
			PlayByPlays: [
				makeRow({ No: 1, ActionCD1: 80 }),
				makeRow({ No: 2, ActionCD1: 1, TeamID: 'A', PlayerID1: 'P1', RestTime: '9:30', Score: null }),
				makeRow({ No: 3, ActionCD1: 2, TeamID: 'A', PlayerID1: 'P1', RestTime: '9:20', Score: null }),
				makeRow({ No: 4, ActionCD1: 81, RestTime: '0:00', Score: null })
			]
		};
		const { events } = transformBLeaguePbp('BLEAGUE2024_29998', payload, 'BLEAGUE2024');

		assert.equal(events[1].is_scoring_play, 1);
		assert.equal(events[1].home_score, 0);
		assert.equal(events[2].is_scoring_play, 0);
		assert.equal(events[3].is_scoring_play, 0);
	});

	test('transformBLeaguePbp should fall back to ACTION_<code> for unknown codes and tolerate bad payloads', () => {
		const payload = {
			Game: { HomeTeamID: 'A', AwayTeamID: 'B' },
			PlayByPlays: [
				makeRow({ No: 1, ActionCD1: 80 }),
				makeRow({ No: 2, ActionCD1: 999, TeamID: 'A', PlayerID1: 'P1', RestTime: '9:00' })
			]
		};
		const { events } = transformBLeaguePbp('BLEAGUE2024_29997', payload, 'BLEAGUE2024');
		assert.equal(events[1].event_type, 'ACTION_999');

		assert.deepEqual(transformBLeaguePbp('BLEAGUE2024_29996', null), { events: [], stints: [] });
		assert.deepEqual(transformBLeaguePbp('BLEAGUE2024_29996', {}), { events: [], stints: [] });
		assert.deepEqual(transformBLeaguePbp('BLEAGUE2024_29996', { PlayByPlays: [] }), { events: [], stints: [] });
		assert.deepEqual(transformBLeaguePbp('BLEAGUE2024_29996', { PlayByPlays: 'not-an-array' }), { events: [], stints: [] });
	});

	test('schemas/bleague/pbp.json should validate play-by-play payloads and reject foreign shapes', () => {
		const payload = new BLeagueScraper().getMockPbpPayload(game1);
		assert.equal(validateSchema('bleague/pbp.json', payload), true);
		assert.equal(validateSchema('bleague/pbp.json', { PlayByPlays: [] }), true);

		// Unified box score payloads are not play-by-play payloads.
		assert.throws(() => validateSchema('bleague/pbp.json', { gameId: game1, homeTeam: {} }), /PlayByPlays/);
		assert.throws(() => validateSchema('bleague/pbp.json', { PlayByPlays: 'nope' }), /JSON Schema Validation Error/);
	});
});

test.describe('B.League Scraper fetchPbp Tests', () => {
	test('fetchPbp should return the mock payload in test mode and pass schema validation', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		assert.equal(scraper.bypassNetwork, true);

		const payload = await scraper.fetchPbp(game1, year);
		assert.equal(payload.PlayByPlays.length, 39);
		assert.equal(payload.Game.HomeTeamID, '9001');
		assert.equal(validateSchema('bleague/pbp.json', payload), true);

		const second = await scraper.fetchPbp(game2, year);
		assert.equal(second.PlayByPlays.length, 6);
		assert.equal(second.Game.AwayTeamNameE, 'YOKOHAMA B-CORSAIRS');
	});

	test('fetchPbp should resolve through the shared payload side-cache used by box scores', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		scraper.bypassNetwork = false;

		const resolved = [];
		scraper.resolvePayload = async (scheduleKey, yearPrefix) => {
			resolved.push([scheduleKey, yearPrefix]);
			return { PlayByPlays: [makeRow({ No: 1, ActionCD1: 80 })], Game: { HomeTeamID: 'A' } };
		};

		const payload = await scraper.fetchPbp(game1, year);
		assert.equal(payload.PlayByPlays.length, 1);
		assert.deepEqual(resolved, [['20001', '2024']]);
	});

	test('fetchPbp should surface transport failures and normalize play-by-play-less payloads', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		scraper.bypassNetwork = false;

		// Both S3 and the game_detail HTML embed failed.
		scraper.resolvePayload = async () => null;
		await assert.rejects(scraper.fetchPbp(game1, year), /No official B.League payload resolved/);

		// Unplayable fixture: the payload exists but has no PlayByPlays section.
		scraper.resolvePayload = async () => ({ Game: { PlayByPlayExistsFlg: false }, HomeBoxscores: [] });
		const empty = await scraper.fetchPbp(game1, year);
		assert.deepEqual(empty, { PlayByPlays: [], Game: { PlayByPlayExistsFlg: false } });
		assert.equal(validateSchema('bleague/pbp.json', empty), true);

		// A game ID without a schedule key never reaches a transport.
		scraper.resolvePayload = async () => { throw new Error('should not be called'); };
		await assert.rejects(scraper.fetchPbp('not-a-bleague-id', year), /Unable to derive a B.League schedule key/);
	});
});

test.describe('Play-by-Play Support Guard Tests', () => {
	test('isPbpSupported should accept implemented leagues and reject the rest', () => {
		for (const supported of ['nba', 'wnba', 'nbl', 'europe', 'bleague', 'BLEAGUE', 'bleague_pbp_test', 'nbl_pbp_test', 'europe_pbp_test', 'europe_lkl_test']) {
			assert.equal(isPbpSupported(supported), true, `${supported} should support PBP`);
		}
		for (const unsupported of ['cba', 'cba_test', 'asia', 'mexico', 'canada', 'puertorico', 'southamerica', 'unknown_league']) {
			assert.equal(isPbpSupported(unsupported), false, `${unsupported} should not support PBP`);
		}
		assert.ok(PBP_SUPPORTED_LEAGUES.has('bleague'));
		assert.ok(!PBP_SUPPORTED_LEAGUES.has('cba'));
	});

	test('assertPbpSupported should throw only for unsupported PBP requests', () => {
		assert.equal(assertPbpSupported('cba', 'traditional'), true);
		assert.equal(assertPbpSupported('bleague', 'pbp'), true);
		assert.equal(assertPbpSupported('nbl', 'pbp'), true);
		assert.throws(() => assertPbpSupported('cba', 'pbp'), /not supported for league "cba"/);
		assert.throws(() => assertPbpSupported('asia', 'pbp'), /Supported PBP leagues: nba, wnba, nbl, europe, bleague/);
	});

	test('extractStage should reject an unsupported league before creating any output or request', async () => {
		await fs.rm(cbaPbpDir, { recursive: true, force: true });
		const scraper = new CbaScraper({ boxscoreType: 'pbp' });

		await assert.rejects(extractStage(scraper, 'cba', '2024', { type: 'pbp' }), /not supported for league "cba"/);

		const dirExists = await fs.access(cbaPbpDir).then(() => true).catch(() => false);
		assert.equal(dirExists, false, 'no PBP output directory may be created for an unsupported league');
	});

	test('run.js should fast-fail an unsupported --type=pbp run with exit code 1', async () => {
		await fs.rm(cbaPbpDir, { recursive: true, force: true });
		const { code, stdout, stderr } = await runCli(['--league=cba', '--years=2024', '--type=pbp', '--step=extract']);

		assert.notEqual(code, 0);
		const output = stdout + stderr;
		assert.match(output, /not supported for league "cba"/);
		assert.match(output, /Supported PBP leagues: nba, wnba, nbl, europe, bleague/);
		assert.ok(!output.includes('Stage 1 [EXTRACT]'), 'the extract stage must never start');

		const dirExists = await fs.access(cbaPbpDir).then(() => true).catch(() => false);
		assert.equal(dirExists, false, 'no PBP output directory may be created for an unsupported league');
	});
});

test.describe('B.League PBP Pipeline Integration Tests', () => {
	/** @type {{events: Record<string, any>[], stints: Record<string, any>[]}|null} Cached transform output */
	let transformedData = null;

	test('Stage 1 extract should persist PlayByPlays payloads for both mock games', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		const extractedGameIds = await extractStage(scraper, league, year, { boxscoreType: 'pbp' });
		assert.deepEqual(extractedGameIds, [game1, game2]);

		for (const gameId of [game1, game2]) {
			const filePath = path.join(testRawDir, `${gameId}.json`);
			const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
			assert.ok(Array.isArray(raw.PlayByPlays) && raw.PlayByPlays.length > 0);
			assert.equal(validateSchema('bleague/pbp.json', raw), true);
		}
	});

	test('Stage 1 extract should skip games that are already in the raw PBP cache', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		let calls = 0;
		const originalFetchPbp = scraper.fetchPbp.bind(scraper);
		scraper.fetchPbp = async (...args) => {
			calls++;
			return originalFetchPbp(...args);
		};

		await extractStage(scraper, league, year, { boxscoreType: 'pbp' });
		assert.equal(calls, 0, 'a warm raw cache must not trigger a second payload resolution');
	});

	test('Stage 1 extract should skip fixtures with empty or missing play-by-play', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		scraper.getSeasonGameSlugs = async function() {
			this.gameSlugs = ['BLEAGUE2024_20003', 'BLEAGUE2024_20004'];
			return this;
		};
		scraper.fetchPbp = async (gameId) => (
			gameId === 'BLEAGUE2024_20003' ? { PlayByPlays: [] } : { Game: { PlayByPlayExistsFlg: false } }
		);

		await extractStage(scraper, league, year, { boxscoreType: 'pbp' });

		for (const gameId of ['BLEAGUE2024_20003', 'BLEAGUE2024_20004']) {
			const exists = await fs.access(path.join(testRawDir, `${gameId}.json`)).then(() => true).catch(() => false);
			assert.equal(exists, false, `${gameId} has no PBP rows and must not be cached`);
		}
	});

	test('Stage 1 extract should skip unplayed fixtures before any payload resolution', async () => {
		const scraper = new BLeagueScraper({ boxscoreType: 'pbp' });
		scraper.getSeasonGameSlugs = async function() {
			this.gameSlugs = ['BLEAGUE2024_20005'];
			return this;
		};
		scraper.unplayedGameIds = new Set(['20005']);
		let calls = 0;
		scraper.fetchPbp = async () => {
			calls++;
			return { PlayByPlays: [makeRow({ No: 1, ActionCD1: 80 })] };
		};

		const extractedGameIds = await extractStage(scraper, league, year, { boxscoreType: 'pbp' });
		assert.deepEqual(extractedGameIds, ['BLEAGUE2024_20005']);
		assert.equal(calls, 0, 'unplayed fixtures must never resolve a payload');

		const exists = await fs.access(path.join(testRawDir, 'BLEAGUE2024_20005.json')).then(() => true).catch(() => false);
		assert.equal(exists, false);
	});

	test('Stage 2 transform should dispatch to the B.League transformer and cache pbp/all/<year>', async () => {
		transformedData = await transformStage(league, year, { boxscoreType: 'pbp' });

		// 39 + 6 mock events, 3 + 1 mock stints.
		assert.equal(transformedData.events.length, 45);
		assert.equal(transformedData.stints.length, 4);
		assert.ok(transformedData.events.every(event => event.competition_id === `BLEAGUE${year}`));
		assert.equal(transformedData.events.filter(event => event.game_id === game1).length, 39);
		assert.equal(transformedData.stints.filter(stint => stint.game_id === game2).length, 1);

		const cachePath = path.resolve(`data/transformed/${league}/pbp/all/${year}/transformed.json`);
		const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
		assert.equal(cache.events.length, 45);
		assert.equal(cache.stints.length, 4);
	});

	test('Stage 3 load should reload PBP from the pbp/all/<year> cache without direct data', async () => {
		assert.ok(transformedData, 'Stage 2 must run before the cache reload test');
		await fs.rm(testDbPath, { force: true });

		// Passing no events/stints forces the load stage onto the cache file written by Stage 2.
		await loadStage(league, year, { players: [], teams: [] }, { boxscoreType: 'pbp' });

		const db = await initDatabase(league);
		try {
			const game1Events = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get(game1);
			assert.equal(game1Events.count, 39);
			const game1Stints = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get(game1);
			assert.equal(game1Stints.count, 3);
			const game2Events = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get(game2);
			assert.equal(game2Events.count, 6);
		} finally {
			db.close();
		}
	});

	test('Stage 3 load should persist PBP rows with correct scoring, assist and stint math', async () => {
		assert.ok(transformedData, 'Stage 2 must run before the database audit test');
		await loadStage(league, year, transformedData, { boxscoreType: 'pbp' });

		const db = await initDatabase(league);
		try {
			const maxScore = db.prepare('SELECT MAX(home_score) as home, MAX(away_score) as away FROM game_play_by_play WHERE game_id = ?').get(game1);
			assert.equal(maxScore.home, 12);
			assert.equal(maxScore.away, 9);

			const basketCount = db.prepare(`SELECT home_score, is_scoring_play FROM game_play_by_play WHERE game_id = ? AND event_type = 'BASKET_COUNT'`).get(game1);
			assert.equal(basketCount.home_score, 5);
			assert.equal(basketCount.is_scoring_play, 0);

			const ast = db.prepare(`SELECT secondary_player_id FROM game_play_by_play WHERE game_id = ? AND event_type = 'AST' ORDER BY rowid`).all(game1);
			assert.deepEqual(ast.map(row => row.secondary_player_id), ['9101', '9102', null]);

			const shot = db.prepare(`SELECT loc_x, loc_y, shot_distance, game_seconds_remaining, sub_type FROM game_play_by_play WHERE game_id = ? AND event_type = '3FGM' ORDER BY rowid LIMIT 1`).get(game1);
			assert.equal(shot.loc_x, 75.5);
			assert.equal(shot.loc_y, 25.0);
			assert.equal(shot.shot_distance, null);
			assert.equal(shot.game_seconds_remaining, 2370);
			assert.equal(shot.sub_type, '27:');

			const ftm = db.prepare(`SELECT sub_type, is_scoring_play FROM game_play_by_play WHERE game_id = ? AND event_type = 'FTM'`).get(game1);
			assert.equal(ftm.sub_type, '35:');
			assert.equal(ftm.is_scoring_play, 1);

			const compIds = db.prepare('SELECT DISTINCT competition_id FROM game_stints WHERE game_id = ?').all(game1);
			assert.deepEqual(compIds.map(row => row.competition_id), [`BLEAGUE${year}`]);

			const stint = db.prepare('SELECT duration_seconds, possessions, home_pts, away_pts FROM game_stints WHERE stint_id = ?').get(`${game1}_stint_1_1`);
			assert.equal(stint.duration_seconds, 75);
			assert.equal(stint.possessions, 4.9);
			assert.equal(stint.home_pts, 6);
			assert.equal(stint.away_pts, 0);

			const emptyStint = db.prepare('SELECT possessions, start_clock, end_clock FROM game_stints WHERE stint_id = ?').get(`${game1}_stint_1_2`);
			assert.equal(emptyStint.possessions, 0);
			assert.equal(emptyStint.start_clock, '8:45');
			assert.equal(emptyStint.end_clock, '0:00');
		} finally {
			db.close();
		}
	});
});
