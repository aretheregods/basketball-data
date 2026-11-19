process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CbaScraper } from '../src/scrapers/cba/CbaScraper.mjs';
import { CbaHarvester } from '../src/scrapers/cba/harvesters/CbaHarvester.mjs';
import {
	parseCbaGame,
	formatUpTime,
	createUnplayedSkeleton
} from '../src/scrapers/cba/parsers/CbaParser.mjs';
import { transformCBA } from '../src/scrapers/cba/cba_transform.mjs';
import { validateSchema } from '../src/utils/schema_validator.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @description Builds a compact, realistic official CBA `data-count` payload. Each side ends
 * with the `团队篮板/失误` summary row (`playerId: null`) that the parser must filter, and the
 * player points sum exactly to the official final scores (117 / 100).
 * @returns {Object} Raw CBA `data-count` payload
 */
function buildCbaPayload() {
	/**
	 * @description Builds one raw official player stat row as returned by `data-count`.
	 * @param {Object} row - Row field values
	 * @returns {Object} Raw `data-count` player row
	 */
	const player = (row) => ({
		playerId: row.playerId,
		gameStart: 1,
		number: row.number,
		cnAlias: row.cnAlias,
		upTime: row.upTime,
		points: row.pts,
		fieldGoalsAttempted: row.fga,
		fieldGoals: row.fgm,
		fieldGoalsPercentage: row.fgm / row.fga * 100,
		threePointAttempted: row.fg3a,
		threePointGoals: row.fg3m,
		threePointPercentage: row.fg3a > 0 ? row.fg3m / row.fg3a * 100 : 0,
		freeThrowsAttempted: row.fta,
		freeThrows: row.ftm,
		freeThrowsPercentage: row.fta > 0 ? row.ftm / row.fta * 100 : 0,
		reboundsOffensive: row.oreb,
		reboundsDefensive: row.dreb,
		rebounds: row.oreb + row.dreb,
		assists: row.ast,
		steals: row.stl,
		blocked: row.blk,
		fouls: row.pf,
		turnovers: row.tov,
		plusMinus: row.plusMinus
	});

	/** @type {Object} */
	const summaryRow = {
		playerId: null,
		gameStart: null,
		number: null,
		cnAlias: '团队篮板/失误',
		upTime: null,
		points: null,
		fieldGoalsAttempted: null,
		fieldGoals: null,
		fieldGoalsPercentage: null,
		threePointAttempted: null,
		threePointGoals: null,
		threePointPercentage: null,
		freeThrowsAttempted: null,
		freeThrows: null,
		freeThrowsPercentage: null,
		reboundsOffensive: null,
		reboundsDefensive: null,
		rebounds: null,
		assists: null,
		steals: null,
		blocked: null,
		fouls: null,
		turnovers: null,
		plusMinus: null
	};

	return {
		homeCounts: [
			player({ playerId: '80001', number: 7, cnAlias: '邹雨宸', upTime: 1905, pts: 34, fgm: 13, fga: 19, fg3m: 2, fg3a: 5, ftm: 6, fta: 7, oreb: 4, dreb: 6, ast: 3, stl: 1, blk: 2, pf: 3, tov: 3, plusMinus: 11 }),
			player({ playerId: '80002', number: 11, cnAlias: '陈国豪', upTime: 1750, pts: 31, fgm: 12, fga: 18, fg3m: 1, fg3a: 3, ftm: 6, fta: 7, oreb: 2, dreb: 8, ast: 2, stl: 1, blk: 1, pf: 4, tov: 2, plusMinus: 8 }),
			player({ playerId: '80003', number: 3, cnAlias: '廖三宁', upTime: 1620, pts: 28, fgm: 10, fga: 17, fg3m: 3, fg3a: 6, ftm: 5, fta: 6, oreb: 0, dreb: 3, ast: 9, stl: 2, blk: 0, pf: 2, tov: 3, plusMinus: 6 }),
			player({ playerId: '80004', number: 21, cnAlias: '俞长栋', upTime: 1499, pts: 24, fgm: 9, fga: 15, fg3m: 2, fg3a: 4, ftm: 4, fta: 4, oreb: 3, dreb: 4, ast: 1, stl: 0, blk: 1, pf: 3, tov: 1, plusMinus: -2 }),
			summaryRow
		],
		visitingCounts: [
			player({ playerId: '81001', number: 5, cnAlias: '林葳', upTime: 2010, pts: 38, fgm: 13, fga: 23, fg3m: 5, fg3a: 12, ftm: 7, fta: 8, oreb: 1, dreb: 3, ast: 6, stl: 2, blk: 0, pf: 3, tov: 4, plusMinus: -7 }),
			player({ playerId: '81002', number: 1, cnAlias: '王岚钦', upTime: 1855, pts: 33, fgm: 11, fga: 19, fg3m: 3, fg3a: 7, ftm: 8, fta: 9, oreb: 1, dreb: 4, ast: 7, stl: 2, blk: 0, pf: 3, tov: 3, plusMinus: -4 }),
			player({ playerId: '81003', number: 9, cnAlias: '曾繁日', upTime: 1710, pts: 29, fgm: 12, fga: 17, fg3m: 0, fg3a: 1, ftm: 5, fta: 6, oreb: 5, dreb: 6, ast: 2, stl: 1, blk: 3, pf: 4, tov: 2, plusMinus: -6 }),
			summaryRow
		]
	};
}

/**
 * @description Game metadata matching {@link buildCbaPayload} (2024-25 season, game 1).
 * @returns {Object} CBA game metadata
 */
function buildCbaMeta() {
	return {
		scheduleId: '100098190',
		status: 4,
		homeTeamId: '29136',
		awayTeamId: '29133',
		homeTeamName: '北京控股',
		awayTeamName: '南京头排苏酒',
		homeScore: 117,
		awayScore: 100,
		gameDate: '2024-12-01'
	};
}

/**
 * @description Raw day-feed game records used by harvester unit tests.
 * @type {{ final: Object, scheduled: Object, exhibition: Object }}
 */
const DAY_FEED_GAMES = {
	final: {
		scheduleId: '100099001',
		homeTeamId: '29124',
		visitingTeamId: '29129',
		homeTeamName: '广东东阳光',
		visitingTeamName: '辽宁本钢',
		matchTypeId: 1,
		status: 4,
		scheduleTime: '2026-10-10 19:35:00',
		homeTeamScore: 98,
		visitingTeamScore: 95
	},
	scheduled: {
		scheduleId: '100099002',
		homeTeamId: '29140',
		visitingTeamId: '29117',
		homeTeamName: '浙江稠州金租',
		visitingTeamName: '新疆伊力特',
		matchTypeId: 2,
		status: 1,
		scheduleTime: '2026-12-01 19:35:00',
		homeTeamScore: null,
		visitingTeamScore: null
	},
	exhibition: {
		scheduleId: '100099003',
		homeTeamId: '29115',
		visitingTeamId: '29125',
		homeTeamName: '北京首钢',
		visitingTeamName: '上海久事',
		matchTypeId: 3,
		status: 4,
		scheduleTime: '2026-10-10 15:00:00',
		homeTeamScore: 88,
		visitingTeamScore: 91
	}
};

test.describe('China CBA Scraper & Pipeline Integration', () => {
	const league = 'cba_test';
	const year = '2024'; // Realistic test year to avoid BaseNormalizer.isGameUnplayed future-dating

	/**
	 * @description Removes every artifact produced by this test run so assertions see a
	 * clean slate (raw payloads, transform cache, and the local test SQLite file).
	 * @returns {Promise<void>}
	 */
	async function cleanTestArtifacts() {
		await fs.rm(path.resolve('data/raw', league), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league), { recursive: true, force: true });
		await fs.rm(path.resolve('data/SQL/CBA_TEST.sqlite'), { force: true });
		await fs.rm(path.resolve('data/SQL/CBA_TEST.sqlite-wal'), { force: true });
		await fs.rm(path.resolve('data/SQL/CBA_TEST.sqlite-shm'), { force: true });
	}

	test.before(cleanTestArtifacts);
	test.after(cleanTestArtifacts);

	test('CbaHarvester should return mock slugs in test mode', async () => {
		const scraper = new CbaScraper();
		const slugs = await scraper.getSeasonGameSlugs('2024');

		assert.equal(slugs.length, 2, 'Should return exactly the two mock CBA games');
		assert.match(slugs[0].split('-').pop(), /^CBA2024_\d+$/);
		assert.match(slugs[1].split('-').pop(), /^CBA2024_\d+$/);
		assert.ok(slugs[0].includes('-CBA2024_'), 'Slugs must contain the CBA prefix segment');
		assert.ok(scraper.unplayedGameIds instanceof Set, 'Unplayed set must be propagated to the scraper');
		assert.equal(scraper.unplayedGameIds.size, 0, 'Mock games are final, so none are unplayed');
		assert.ok(scraper.gameIndex instanceof Map, 'Game index must be propagated to the scraper');
		assert.equal(scraper.gameIndex.size, 0, 'Mock mode harvests no real schedule metadata');
	});

	test('CbaHarvester should build month and day schedule endpoints', () => {
		const harvester = new CbaHarvester();
		assert.equal(harvester.buildMonthUrl(2024, 12), '/schedules/month?year=2024&month=12');
		assert.equal(harvester.buildDayUrl('2024-12-01'), '/schedules/day?day=2024-12-01&auto=0');
	});

	test('CbaHarvester.parseScheduleGame should parse in-scope games and reject exhibitions', () => {
		const harvester = new CbaHarvester();

		const finalGame = harvester.parseScheduleGame(DAY_FEED_GAMES.final, '2026');
		assert.ok(finalGame);
		assert.equal(finalGame.scheduleId, '100099001');
		assert.equal(finalGame.homeTeamName, '广东东阳光');
		assert.equal(finalGame.visitingTeamName, '辽宁本钢');
		assert.equal(finalGame.homeTeamId, '29124');
		assert.equal(finalGame.visitingTeamId, '29129');
		assert.equal(finalGame.homeScore, 98);
		assert.equal(finalGame.visitingScore, 95);
		assert.equal(finalGame.gameDate, '2026-10-10');
		assert.equal(finalGame.status, 4);
		assert.equal(finalGame.matchTypeId, 1);
		assert.equal(finalGame.isFinal, true);
		assert.equal(finalGame.slug, '广东东阳光-vs-辽宁本钢-CBA2026_100099001');

		const scheduledGame = harvester.parseScheduleGame(DAY_FEED_GAMES.scheduled, '2026');
		assert.ok(scheduledGame);
		assert.equal(scheduledGame.status, 1);
		assert.equal(scheduledGame.isFinal, false);
		assert.equal(scheduledGame.homeScore, null);

		// All-Star / tournament fixtures (matchTypeId outside 1/2) are out of scope.
		assert.equal(harvester.parseScheduleGame(DAY_FEED_GAMES.exhibition, '2026'), null);

		// Malformed records never produce a game entry.
		assert.equal(harvester.parseScheduleGame(null, '2026'), null);
		assert.equal(harvester.parseScheduleGame('not-an-object', '2026'), null);
		assert.equal(harvester.parseScheduleGame({ ...DAY_FEED_GAMES.final, scheduleId: '' }, '2026'), null);
	});

	test('CbaHarvester should month pre-filter the day walk and mark non-final fixtures as unplayed', async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		const scraper = { unplayedGameIds: null, gameIndex: null };
		const harvester = new CbaHarvester(scraper);
		harvester.requestDelayMs = 0;

		/** @type {string[]} */
		const requestedUrls = [];
		harvester.request = async (url) => {
			requestedUrls.push(String(url));
			if (url.includes('/schedules/month?')) {
				// Only October and December host games; scheduleNum 0 days are never walked.
				if (url.includes('year=2026&month=10')) {
					return [{ scheduleNum: 2, scheduleTime: '2026-10-10 00:00:00' }];
				}
				if (url.includes('year=2026&month=12')) {
					return [
						{ scheduleNum: 1, scheduleTime: '2026-12-01 00:00:00' },
						{ scheduleNum: 0, scheduleTime: '2026-12-02 00:00:00' }
					];
				}
				return [];
			}
			if (url.includes('/schedules/day?day=2026-10-10')) {
				return [DAY_FEED_GAMES.final, DAY_FEED_GAMES.exhibition];
			}
			if (url.includes('/schedules/day?day=2026-12-01')) {
				return [DAY_FEED_GAMES.scheduled];
			}
			return [];
		};

		try {
			const slugs = await harvester.getSeasonGameSlugs('2026');
			assert.equal(slugs.length, 2, 'Both in-scope fixtures must be preserved');
			assert.ok(slugs.some(s => s.endsWith('-CBA2026_100099001')));
			assert.ok(slugs.some(s => s.endsWith('-CBA2026_100099002')));
			assert.ok(!slugs.some(s => s.includes('100099003')), 'Exhibition games must be excluded');

			// Final past game stays fetchable; non-final fixture is skipped.
			assert.deepEqual([...harvester.unplayedGameIds], ['100099002']);
			assert.equal(scraper.unplayedGameIds, harvester.unplayedGameIds, 'Scraper must receive the unplayed set');
			assert.equal(scraper.gameIndex, harvester.gameIndex, 'Scraper must receive the game index');
			assert.equal(harvester.gameIndex.size, 2);
			assert.equal(harvester.gameIndex.get('100099001').homeScore, 98);

			// 12 month pre-filter requests, but only game-hosting days are walked.
			assert.equal(requestedUrls.filter(u => u.includes('/schedules/month?')).length, 12);
			assert.equal(requestedUrls.filter(u => u.includes('/schedules/day?')).length, 2, 'Only game days may be walked');
			assert.ok(!requestedUrls.some(u => u.includes('day=2026-12-02')), 'Zero-game days must never be walked');
			assert.ok(requestedUrls.every(u => u.startsWith('/schedules/')), 'All requests must target schedule feeds');
		} finally {
			process.env.NODE_ENV = originalNodeEnv;
		}
	});

	test('CbaHarvester should reject non-numeric season years', async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		const harvester = new CbaHarvester();
		try {
			await assert.rejects(() => harvester.getSeasonGameSlugs('not-a-year'), /Invalid CBA season year/);
		} finally {
			process.env.NODE_ENV = originalNodeEnv;
		}
	});

	test('CbaScraper should parse unified game IDs and build official gameReport URLs', () => {
		const scraper = new CbaScraper();
		const parts = scraper.parseGameId('CBA2024_100110420');
		assert.deepEqual(parts, {
			competitionId: 'cba',
			seasonCode: '2024',
			gameCode: '100110420',
			yearPrefix: '2024',
			scheduleKey: '100110420'
		});
		assert.equal(scraper.getGameEndpoint('CBA2024_100110420'), 'https://www.cbaleague.com/data/#/gameReport?scheduleId=100110420');
		assert.equal(scraper.getGameUrl('CBA2024_100110420'), 'CBA2024_100110420');
	});

	test('CbaScraper should return schema-compliant mock box scores in test mode', async () => {
		const scraper = new CbaScraper();

		// Game 1: 广东东阳光 86 - 辽宁本钢 69
		const game1 = await scraper.request('CBA2024_20001');
		assert.equal(game1.gameId, 'CBA2024_20001');
		assert.equal(game1.season, '2024');
		assert.equal(game1.homeTeam.teamId, '29124');
		assert.equal(game1.homeTeam.teamName, '广东东阳光');
		assert.equal(game1.homeTeam.score, 86);
		assert.equal(game1.awayTeam.teamName, '辽宁本钢');
		assert.equal(game1.awayTeam.score, 69);

		const humingxuan = game1.homeTeam.players.find(p => p.playerName === '胡明轩');
		assert.ok(humingxuan);
		assert.equal(humingxuan.playerId, '90001');
		assert.equal(humingxuan.statistics.pts, 30);
		assert.equal(humingxuan.statistics.min, '31:05');
		assert.equal(humingxuan.statistics.reb, 5);

		const zhaojiwei = game1.awayTeam.players.find(p => p.playerName === '赵继伟');
		assert.ok(zhaojiwei);
		assert.equal(zhaojiwei.playerId, '90004');
		assert.equal(zhaojiwei.statistics.pts, 36);
		assert.equal(zhaojiwei.statistics.min, '35:20');
		assert.equal(validateSchema('cba/boxscore.json', game1), true);

		// Player points sum exactly to the official scores (no reconciliation rows later).
		const homeSum = game1.homeTeam.players.reduce((acc, p) => acc + p.statistics.pts, 0);
		const awaySum = game1.awayTeam.players.reduce((acc, p) => acc + p.statistics.pts, 0);
		assert.equal(homeSum, game1.homeTeam.score);
		assert.equal(awaySum, game1.awayTeam.score);

		// Game 2: 浙江稠州金租 78 - 新疆伊力特 85
		const game2 = await scraper.request('CBA2024_20002');
		assert.equal(game2.homeTeam.teamName, '浙江稠州金租');
		assert.equal(game2.homeTeam.score, 78);
		assert.equal(game2.awayTeam.teamName, '新疆伊力特');
		assert.equal(game2.awayTeam.score, 85);

		const wuqian = game2.homeTeam.players.find(p => p.playerName === '吴前');
		assert.ok(wuqian);
		assert.equal(wuqian.statistics.pts, 44);
		assert.equal(wuqian.statistics.min, '36:15');

		const abudu = game2.awayTeam.players.find(p => p.playerName === '阿不都沙拉木');
		assert.ok(abudu);
		assert.equal(abudu.statistics.pts, 45);
		assert.equal(validateSchema('cba/boxscore.json', game2), true);
	});

	test('CbaScraper should return an unplayed skeleton when no schedule ID can be derived', async () => {
		const scraper = new CbaScraper();
		scraper.bypassNetwork = false; // Missing schedule ID must fail before any network I/O
		const skeleton = await scraper.request('malformed-game-id');
		assert.equal(skeleton.homeTeam.teamName, 'Unplayed');
		assert.equal(skeleton.awayTeam.teamName, 'Unplayed');
		assert.deepEqual(skeleton.homeTeam.players, []);
		assert.deepEqual(skeleton.awayTeam.players, []);
		assert.equal(validateSchema('cba/boxscore.json', skeleton), true);
	});

	test('CbaParser.formatUpTime should convert played seconds to MM:SS clocks', () => {
		assert.equal(formatUpTime(1865), '31:05');
		assert.equal(formatUpTime(2010), '33:30');
		assert.equal(formatUpTime(65), '01:05');
		assert.equal(formatUpTime(59), '00:59');
		assert.equal(formatUpTime(0), '00:00');
		assert.equal(formatUpTime(-10), '00:00');
		assert.equal(formatUpTime(null), '00:00');
		assert.equal(formatUpTime(undefined), '00:00');
		assert.equal(formatUpTime('garbage'), '00:00');
	});

	test('CbaParser.parseCbaGame should filter the summary row and map unified statistics', () => {
		const boxscore = parseCbaGame(buildCbaPayload(), 'CBA2024_100098190', '2024', buildCbaMeta());

		assert.equal(boxscore.gameId, 'CBA2024_100098190');
		assert.equal(boxscore.season, '2024');
		assert.equal(boxscore.gameDate, '2024-12-01');

		assert.equal(boxscore.homeTeam.teamId, '29136');
		assert.equal(boxscore.homeTeam.teamName, '北京控股');
		assert.equal(boxscore.homeTeam.score, 117);
		assert.equal(boxscore.awayTeam.teamId, '29133');
		assert.equal(boxscore.awayTeam.teamName, '南京头排苏酒');
		assert.equal(boxscore.awayTeam.score, 100);

		// The `团队篮板/失误` summary row (playerId null) must be filtered from both sides.
		assert.equal(boxscore.homeTeam.players.length, 4, 'Only real player rows survive');
		assert.equal(boxscore.awayTeam.players.length, 3, 'Only real player rows survive');
		assert.ok(boxscore.homeTeam.players.every(p => p.playerId !== '' && p.playerName !== '团队篮板/失误'));
		assert.ok(boxscore.awayTeam.players.every(p => p.playerId !== '' && p.playerName !== '团队篮板/失误'));

		const zou = boxscore.homeTeam.players.find(p => p.playerId === '80001');
		assert.ok(zou);
		assert.equal(zou.playerName, '邹雨宸');
		assert.equal(zou.statistics.pts, 34);
		assert.equal(zou.statistics.min, '31:45', 'upTime seconds must be converted to MM:SS');
		assert.equal(zou.statistics.fgm, 13);
		assert.equal(zou.statistics.fga, 19);
		assert.equal(zou.statistics.fg3m, 2);
		assert.equal(zou.statistics.fg3a, 5);
		assert.equal(zou.statistics.ftm, 6);
		assert.equal(zou.statistics.fta, 7);
		assert.equal(zou.statistics.oreb, 4);
		assert.equal(zou.statistics.dreb, 6);
		assert.equal(zou.statistics.reb, 10);
		assert.equal(zou.statistics.ast, 3);
		assert.equal(zou.statistics.stl, 1);
		assert.equal(zou.statistics.blk, 2);
		assert.equal(zou.statistics.tov, 3);
		assert.equal(zou.statistics.pf, 3);
		assert.equal(zou.statistics.plus_minus, 11);

		// Player points sum exactly to the official final scores.
		const homeSum = boxscore.homeTeam.players.reduce((acc, p) => acc + p.statistics.pts, 0);
		const awaySum = boxscore.awayTeam.players.reduce((acc, p) => acc + p.statistics.pts, 0);
		assert.equal(homeSum, 117);
		assert.equal(awaySum, 100);

		const linwei = boxscore.awayTeam.players.find(p => p.playerId === '81001');
		assert.ok(linwei);
		assert.equal(linwei.playerName, '林葳');
		assert.equal(linwei.statistics.pts, 38);
		assert.equal(linwei.statistics.min, '33:30');
		assert.equal(linwei.statistics.plus_minus, -7);

		assert.equal(validateSchema('cba/boxscore.json', boxscore), true);
	});

	test('CbaParser.parseCbaGame should return skeletons for non-final and summary-only games', () => {
		const payload = buildCbaPayload();

		// Known status that is not final: never expose partial statistics.
		const live = parseCbaGame(
			payload,
			'CBA2024_100098190',
			'2024',
			{ ...buildCbaMeta(), status: 2 }
		);
		assert.equal(live.homeTeam.teamName, '北京控股', 'Known team identity is retained for logging');
		assert.deepEqual(live.homeTeam.players, []);
		assert.deepEqual(live.awayTeam.players, []);

		const scheduled = parseCbaGame(
			payload,
			'CBA2024_100098190',
			'2024',
			{ ...buildCbaMeta(), status: 1, homeScore: null, awayScore: null }
		);
		assert.deepEqual(scheduled.homeTeam.players, []);

		// Final status but only the filtered summary row (future/forfeit shape).
		const summaryOnly = parseCbaGame(
			{ homeCounts: payload.homeCounts.slice(-1), visitingCounts: payload.visitingCounts.slice(-1) },
			'CBA2024_100098190',
			'2024',
			buildCbaMeta()
		);
		assert.equal(summaryOnly.homeTeam.teamName, '北京控股');
		assert.equal(summaryOnly.homeTeam.score, 117, 'Official score is retained on skeletons');
		assert.deepEqual(summaryOnly.homeTeam.players, []);
		assert.deepEqual(summaryOnly.awayTeam.players, []);

		// Missing metadata entirely still parses the payload (defensive standalone use).
		const metaless = parseCbaGame(payload, 'CBA2024_100098190', '2024');
		assert.equal(metaless.homeTeam.players.length, 4);
		assert.equal(metaless.homeTeam.teamName, '');

		// createUnplayedSkeleton (exported) keeps the unified shape.
		const skeleton = createUnplayedSkeleton('CBA2024_999999', '2024');
		assert.equal(skeleton.gameId, 'CBA2024_999999');
		assert.equal(skeleton.homeTeam.teamName, 'Unplayed');
		assert.equal(validateSchema('cba/boxscore.json', skeleton), true);

		// Non-object payloads are programming errors and must throw.
		assert.throws(() => parseCbaGame(null, 'CBA2024_100098190', '2024'), /is not an object/);
		assert.throws(() => parseCbaGame('nope', 'CBA2024_100098190', '2024'), /is not an object/);
		assert.throws(() => parseCbaGame([], 'CBA2024_100098190', '2024'), /is not an object/);
	});

	test('extractStage should skip unplayed CBA fixtures before scraper.request', async () => {
		let requestCalls = 0;
		const scraper = {
			gameSlugs: [],
			unplayedGameIds: new Set(['20003']),
			async getSeasonGameSlugs() {
				this.gameSlugs = ['广东东阳光-vs-辽宁本钢-CBA2024_20003'];
			},
			getGameEndpoint() {
				requestCalls += 1;
				throw new Error('endpoint should not be reached for an unplayed fixture');
			},
			getGameUrl() {
				requestCalls += 1;
				throw new Error('url should not be reached for an unplayed fixture');
			},
			async request() {
				requestCalls += 1;
				throw new Error('request should not be reached for an unplayed fixture');
			}
		};

		const gameIds = await extractStage(scraper, league, year);
		assert.deepEqual(gameIds, ['CBA2024_20003']);
		assert.equal(requestCalls, 0, 'Unplayed fixtures must be skipped before any game-page access');

		const filePath = path.resolve('data/raw', league, year, 'CBA2024_20003.json');
		await assert.rejects(() => fs.stat(filePath), 'No raw cache file may be written for an unplayed fixture');
	});

	test('transformCBA should skip unplayed skeletons, reconcile points variance, and surface unreadable directories', async () => {
		// Missing directory: warn + empty result rather than crashing.
		const missing = await transformCBA(path.resolve('data/raw', league, 'does-not-exist'), year);
		assert.deepEqual(missing, { players: [], teams: [] });

		const unitDir = path.resolve('data/raw', league, 'unit_transform');
		await fs.mkdir(unitDir, { recursive: true });
		try {
			// Unplayed skeleton files are dropped instead of transformed.
			await fs.writeFile(
				path.join(unitDir, 'CBA2024_90009.json'),
				JSON.stringify(createUnplayedSkeleton('CBA2024_90009', year)),
				'utf8'
			);
			const skipped = await transformCBA(unitDir, year);
			assert.deepEqual(skipped, { players: [], teams: [] });

			// Official team score above the player point sum lands on a Team/Bench row.
			await fs.writeFile(
				path.join(unitDir, 'CBA2024_90010.json'),
				JSON.stringify({
					gameId: 'CBA2024_90010',
					season: year,
					gameDate: '2024-12-05',
					homeTeam: {
						teamId: '29124',
						teamName: '广东东阳光',
						score: 90,
						players: [{
							playerId: '90001',
							playerName: '胡明轩',
							statistics: {
								min: '30:00', pts: 86, fgm: 30, fga: 40, fg3m: 6, fg3a: 12, ftm: 20, fta: 22,
								oreb: 2, dreb: 5, reb: 7, ast: 4, stl: 2, blk: 0, tov: 3, pf: 2, plus_minus: 4
							}
						}]
					},
					awayTeam: {
						teamId: '29129',
						teamName: '辽宁本钢',
						score: 80,
						players: [{
							playerId: '90004',
							playerName: '赵继伟',
							statistics: {
								min: '30:00', pts: 80, fgm: 28, fga: 38, fg3m: 8, fg3a: 16, ftm: 16, fta: 18,
								oreb: 1, dreb: 4, reb: 5, ast: 8, stl: 3, blk: 0, tov: 2, pf: 3, plus_minus: -4
							}
						}]
					}
				}),
				'utf8'
			);
			const reconciled = await transformCBA(unitDir, year);
			assert.equal(reconciled.teams.length, 2, 'The skeleton game must not produce team rows');
			assert.equal(reconciled.players.length, 3, '2 players + 1 variance row');

			const varianceRow = reconciled.players.find(p => p.player_name === 'Team/Bench');
			assert.ok(varianceRow);
			assert.equal(varianceRow.pts, 4, '90 official - 86 player sum');
			assert.equal(varianceRow.team_id, 'guangdong-tigers');
			assert.equal(varianceRow.player_id, 'guangdong-tigers_team');
			assert.equal(varianceRow.comment, 'Points Variance Reconciliation');
			assert.equal(varianceRow.league, 'cba');

			const awayPlayer = reconciled.players.find(p => p.player_id === '90004');
			assert.ok(awayPlayer);
			assert.equal(awayPlayer.team_id, 'liaoning-leopards');

			// Malformed JSON must reject instead of silently dropping data.
			await fs.writeFile(path.join(unitDir, 'broken.json'), '{ not valid json', 'utf8');
			await assert.rejects(() => transformCBA(unitDir, year));
		} finally {
			await fs.rm(unitDir, { recursive: true, force: true });
		}
	});

	test('2-transform should only dispatch CBA to its league-owned transform file', async () => {
		const stageSource = await fs.readFile(path.resolve('src/stages/2-transform.mjs'), 'utf8');
		assert.ok(stageSource.includes('../scrapers/cba/cba_transform.mjs'), 'Stage must import the league-owned transform');
		assert.ok(stageSource.includes('transformCBA(rawDir, year)'), 'Stage must dispatch to transformCBA');
		assert.ok(!stageSource.includes('cbaMappings'), 'No league-specific mapping loader may live in the general stage');
		assert.ok(!stageSource.includes('config/cba_team_mappings.json'), 'League config must be owned by the league transform');
	});

	test('Full China CBA Pipeline Integration: Extract -> Transform -> Load', async () => {
		// 1. STAGE 1: Extract (test mode serves mock official payloads)
		const scraper = new CbaScraper();
		const gameIds = await extractStage(scraper, league, year);
		assert.ok(gameIds.includes('CBA2024_20001'));
		assert.ok(gameIds.includes('CBA2024_20002'));

		const rawFiles = await fs.readdir(path.resolve('data/raw', league, year));
		assert.ok(rawFiles.includes('CBA2024_20001.json'));
		assert.ok(rawFiles.includes('CBA2024_20002.json'));

		// 2. STAGE 2: Transform (league-owned cba_transform.mjs)
		const transformed = await transformStage(league, year);
		assert.equal(transformed.players.length, 9, '3 + 2 + 2 + 2 mock players, no variance rows');
		assert.equal(transformed.teams.length, 4, 'One team row per game side');

		const humingxuan = transformed.players.find(p => p.game_id === 'CBA2024_20001' && p.player_id === '90001');
		assert.ok(humingxuan);
		assert.equal(humingxuan.team_id, 'guangdong-tigers'); // mapped from config/cba_team_mappings.json
		assert.equal(humingxuan.player_name, '胡明轩');
		assert.equal(humingxuan.normalized_name, '胡明轩', 'Chinese-native names are preserved');
		assert.equal(humingxuan.pts, 30);
		assert.equal(humingxuan.min, '31.1'); // "31:05" -> 31.1 minutes
		assert.equal(humingxuan.fgm, 11);
		assert.equal(humingxuan.fg3m, 4);
		assert.equal(humingxuan.plus_minus, 12);
		assert.equal(humingxuan.season, '2024');
		assert.equal(humingxuan.league, 'cba');

		const zhaojiwei = transformed.players.find(p => p.game_id === 'CBA2024_20001' && p.player_id === '90004');
		assert.ok(zhaojiwei);
		assert.equal(zhaojiwei.team_id, 'liaoning-leopards');

		const abudu = transformed.players.find(p => p.game_id === 'CBA2024_20002' && p.player_id === '90008');
		assert.ok(abudu);
		assert.equal(abudu.team_id, 'xinjiang-flying-tigers');
		assert.equal(abudu.pts, 45);

		const wuqian = transformed.players.find(p => p.game_id === 'CBA2024_20002' && p.player_id === '90006');
		assert.ok(wuqian);
		assert.equal(wuqian.team_id, 'zhejiang-golden-bulls');
		assert.equal(wuqian.min, '36.3'); // "36:15" -> 36.25 -> 36.3 minutes

		// Mock player points sum exactly to official scores: no reconciliation rows.
		const varianceRows = transformed.players.filter(p => p.player_name === 'Team/Bench');
		assert.equal(varianceRows.length, 0, 'Exact point sums produce no Team/Bench rows');

		// Team rows carry official scores and league rollup tags.
		const teamIds = transformed.teams.map(t => t.team_id).sort();
		assert.deepEqual(teamIds, ['guangdong-tigers', 'liaoning-leopards', 'xinjiang-flying-tigers', 'zhejiang-golden-bulls']);
		const guangdongTeam = transformed.teams.find(t => t.game_id === 'CBA2024_20001' && t.team_id === 'guangdong-tigers');
		assert.ok(guangdongTeam);
		assert.equal(guangdongTeam.pts, 86);
		assert.equal(guangdongTeam.plus_minus, 17); // 86 - 69
		assert.equal(guangdongTeam.team_name, '广东东阳光');
		assert.equal(guangdongTeam.fgm, 30, 'Team totals aggregate player statistics');
		assert.equal(guangdongTeam.league, 'cba');
		assert.ok(transformed.teams.every(t => t.league === 'cba'));

		// 3. STAGE 3: Load
		await loadStage(league, year, transformed);

		// 4. Verify in the local staging database
		const db = await initDatabase(league);
		try {
			const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('cba', year);
			assert.equal(playerStats.length, 9, 'All mock players must land in the database');
			assert.ok(playerStats.every(p => p.league === 'cba'), 'Rows must be tagged with the standalone league key');

			const dbHumingxuan = playerStats.find(p => p.game_id === 'CBA2024_20001' && String(p.player_id) === '90001');
			assert.ok(dbHumingxuan);
			assert.equal(dbHumingxuan.pts, 30);
			assert.equal(dbHumingxuan.min, '31.1');
			assert.equal(dbHumingxuan.team_id, 'guangdong-tigers');
			assert.equal(dbHumingxuan.player_name, '胡明轩');
			assert.equal(dbHumingxuan.normalized_name, '胡明轩');
			assert.ok(dbHumingxuan.game_score > 0, 'game_score should be derived');

			const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('cba', year);
			assert.equal(teamStats.length, 4);
			assert.ok(teamStats.some(t => t.team_id === 'guangdong-tigers' && t.pts === 86));
			assert.ok(teamStats.some(t => t.team_id === 'liaoning-leopards' && t.pts === 69));
			assert.ok(teamStats.some(t => t.team_id === 'zhejiang-golden-bulls' && t.pts === 78));
			assert.ok(teamStats.some(t => t.team_id === 'xinjiang-flying-tigers' && t.pts === 85));

			// CBA must stay in its own database: no rows may carry another league key.
			const strayRows = db.prepare("SELECT COUNT(*) AS n FROM player_game_stats WHERE game_id LIKE 'CBA%' AND league != 'cba'").get();
			assert.equal(strayRows.n, 0);
		} finally {
			db.close();
		}
	});
});
