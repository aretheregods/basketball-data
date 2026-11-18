process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BLeagueScraper } from '../src/scrapers/bleague/BLeagueScraper.mjs';
import { BLeagueHarvester } from '../src/scrapers/bleague/harvesters/BLeagueHarvester.mjs';
import {
	parseBLeaguePayload,
	extractEmbeddedPayload,
	parseGameDateTime,
	createUnplayedSkeleton
} from '../src/scrapers/bleague/parsers/BLeagueParser.mjs';
import { transformBLeague } from '../src/scrapers/bleague/bleague_transform.mjs';
import { validateSchema } from '../src/utils/schema_validator.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @description Builds a compact, realistic official B.League `v2_genius_contexts` payload
 * (Game header + Category 1/2/3 rows across PeriodCategory 1/15/18) used by the parser tests.
 * Full-game (PeriodCategory 18) player points sum exactly to the official final scores.
 * @returns {Object} Raw B.League game payload
 */
function buildGamePayload() {
	/** @type {Object[]} */
	const homeBoxscores = [
		// Quarter 1 partial rows (must be excluded by full-game selection)
		{
			Code: 546, PeriodCategory: 1, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50001', PlayerNameE: 'Sota Okada', PlayTime: '10:00',
			Point: 8, PT2M: 3, PT2A: 5, PT3M: 1, PT3A: 2, FTM: 1, FTA: 2,
			FOUL: 1, RB_OFF: 0, RB_DEF: 2, RB_TOT: 2, TO: 1, AS: 2, ST: 1, BS: 0, PLUSMINUS: 4
		},
		{
			Code: 546, PeriodCategory: 1, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50002', PlayerNameE: 'Leonard Jackson', PlayTime: '9:30',
			Point: 4, PT2M: 2, PT2A: 4, PT3M: 0, PT3A: 1, FTM: 0, FTA: 0,
			FOUL: 1, RB_OFF: 1, RB_DEF: 2, RB_TOT: 3, TO: 0, AS: 0, ST: 0, BS: 1, PLUSMINUS: 2
		},
		// First-half partial row (must be excluded by full-game selection)
		{
			Code: 547, PeriodCategory: 15, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50001', PlayerNameE: 'Sota Okada', PlayTime: '17:20',
			Point: 15, PT2M: 5, PT2A: 8, PT3M: 2, PT3A: 4, FTM: 1, FTA: 2,
			FOUL: 2, RB_OFF: 1, RB_DEF: 3, RB_TOT: 4, TO: 2, AS: 4, ST: 1, BS: 0, PLUSMINUS: 7
		},
		// Full-game rows (PeriodCategory 18) - points sum to 86
		{
			Code: 548, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50001', PlayerNameE: 'Sota Okada', PlayTime: '31:05',
			Point: 24, PT2M: 6, PT2A: 9, PT3M: 3, PT3A: 7, FTM: 3, FTA: 4,
			FOUL: 2, RB_OFF: 1, RB_DEF: 4, RB_TOT: 5, TO: 3, AS: 7, ST: 2, BS: 0, PLUSMINUS: 14
		},
		{
			Code: 548, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50002', PlayerNameE: 'Leonard Jackson', PlayTime: '24:10',
			Point: 15, PT2M: 5, PT2A: 8, PT3M: 1, PT3A: 3, FTM: 2, FTA: 2,
			FOUL: 3, RB_OFF: 2, RB_DEF: 6, RB_TOT: 8, TO: 1, AS: 1, ST: 1, BS: 1, PLUSMINUS: 9
		},
		{
			Code: 548, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50011', PlayerNameE: 'Taito Nakahara', PlayTime: '26:40',
			Point: 20, PT2M: 8, PT2A: 12, PT3M: 0, PT3A: 2, FTM: 4, FTA: 5,
			FOUL: 2, RB_OFF: 1, RB_DEF: 5, RB_TOT: 6, TO: 2, AS: 3, ST: 1, BS: 0, PLUSMINUS: 11
		},
		{
			Code: 548, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50012', PlayerNameE: 'Ryosuke Shirase', PlayTime: '22:15',
			Point: 14, PT2M: 3, PT2A: 7, PT3M: 2, PT3A: 6, FTM: 2, FTA: 2,
			FOUL: 1, RB_OFF: 0, RB_DEF: 4, RB_TOT: 4, TO: 1, AS: 2, ST: 0, BS: 0, PLUSMINUS: 5
		},
		{
			Code: 548, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50013', PlayerNameE: 'Kaito Itabashi', PlayTime: '18:50',
			Point: 13, PT2M: 4, PT2A: 7, PT3M: 1, PT3A: 3, FTM: 2, FTA: 2,
			FOUL: 2, RB_OFF: 1, RB_DEF: 3, RB_TOT: 4, TO: 0, AS: 1, ST: 1, BS: 0, PLUSMINUS: 3
		},
		// DNP full-game row (PlayTime is not a MM:SS string)
		{
			Code: 548, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '50014', PlayerNameE: 'Yuki Shibuya', PlayTime: 'DNP',
			Point: 0, PT2M: 0, PT2A: 0, PT3M: 0, PT3A: 0, FTM: 0, FTA: 0,
			FOUL: 0, RB_OFF: 0, RB_DEF: 0, RB_TOT: 0, TO: 0, AS: 0, ST: 0, BS: 0, PLUSMINUS: 0
		},
		// Blank filler row (Category 2) - must be excluded
		{
			Code: 549, PeriodCategory: 18, ScheduleKey: 506601, Category: 2,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '', PlayerNameE: '', PlayTime: '', Point: 0
		},
		// Team total row (Category 3) - must be excluded
		{
			Code: 550, PeriodCategory: 18, ScheduleKey: 506601, Category: 3,
			TeamID: '2488', TeamNameE: 'NAGASAKI VELCA',
			PlayerID: '', PlayerNameE: '', PlayTime: '200:00', Point: 86
		}
	];

	/** @type {Object[]} */
	const awayBoxscores = [
		// Quarter 1 partial row (must be excluded)
		{
			Code: 551, PeriodCategory: 1, ScheduleKey: 506601, Category: 1,
			TeamID: '2479', TeamNameE: 'SEAHORSES MIKAWA',
			PlayerID: '50005', PlayerNameE: 'Hayato Kumagai', PlayTime: '10:00',
			Point: 6, PT2M: 3, PT2A: 5, PT3M: 0, PT3A: 1, FTM: 0, FTA: 0,
			FOUL: 1, RB_OFF: 1, RB_DEF: 2, RB_TOT: 3, TO: 1, AS: 1, ST: 0, BS: 0, PLUSMINUS: -3
		},
		// Full-game rows (PeriodCategory 18) - points sum to 69
		{
			Code: 552, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2479', TeamNameE: 'SEAHORSES MIKAWA',
			PlayerID: '50005', PlayerNameE: 'Hayato Kumagai', PlayTime: '30:50',
			Point: 19, PT2M: 6, PT2A: 9, PT3M: 2, PT3A: 6, FTM: 1, FTA: 2,
			FOUL: 4, RB_OFF: 3, RB_DEF: 5, RB_TOT: 8, TO: 2, AS: 2, ST: 1, BS: 0, PLUSMINUS: -14
		},
		{
			Code: 552, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2479', TeamNameE: 'SEAHORSES MIKAWA',
			PlayerID: '50021', PlayerNameE: 'Keita Takeda', PlayTime: '28:05',
			Point: 18, PT2M: 7, PT2A: 11, PT3M: 1, PT3A: 4, FTM: 1, FTA: 2,
			FOUL: 3, RB_OFF: 0, RB_DEF: 5, RB_TOT: 5, TO: 2, AS: 4, ST: 1, BS: 0, PLUSMINUS: -6
		},
		{
			Code: 552, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2479', TeamNameE: 'SEAHORSES MIKAWA',
			PlayerID: '50022', PlayerNameE: 'Shogo Asai', PlayTime: '25:30',
			Point: 16, PT2M: 5, PT2A: 9, PT3M: 2, PT3A: 6, FTM: 2, FTA: 2,
			FOUL: 2, RB_OFF: 1, RB_DEF: 3, RB_TOT: 4, TO: 1, AS: 1, ST: 2, BS: 0, PLUSMINUS: -4
		},
		{
			Code: 552, PeriodCategory: 18, ScheduleKey: 506601, Category: 1,
			TeamID: '2479', TeamNameE: 'SEAHORSES MIKAWA',
			PlayerID: '50023', PlayerNameE: 'Daiichi Kojima', PlayTime: '21:10',
			Point: 16, PT2M: 6, PT2A: 10, PT3M: 1, PT3A: 4, FTM: 1, FTA: 1,
			FOUL: 3, RB_OFF: 2, RB_DEF: 2, RB_TOT: 4, TO: 3, AS: 3, ST: 0, BS: 1, PLUSMINUS: -9
		},
		// Team total row (Category 3) - must be excluded
		{
			Code: 553, PeriodCategory: 18, ScheduleKey: 506601, Category: 3,
			TeamID: '2479', TeamNameE: 'SEAHORSES MIKAWA',
			PlayerID: '', PlayerNameE: '', PlayTime: '200:00', Point: 69
		}
	];

	return {
		Game: {
			ScheduleKey: 506601,
			GameEndedFlg: true,
			GameDateTime: '/Date(1733047200000+0900)/',
			StadiumNameE: 'Arena } { "Quoted" Stadium',
			HomeTeamID: '2488',
			HomeTeamNameE: 'NAGASAKI VELCA',
			HomeTeamShortNameE: 'NAGA',
			HomeTeamScore: 86,
			AwayTeamID: '2479',
			AwayTeamNameE: 'SEAHORSES MIKAWA',
			AwayTeamShortNameE: 'MIKA',
			AwayTeamScore: 69
		},
		HomeBoxscores: homeBoxscores,
		AwayBoxscores: awayBoxscores,
		Summaries: [
			{ PeriodCategory: 1, TeamID: '2488', Point: 12 },
			{ PeriodCategory: 18, TeamID: '2488', Point: 86 },
			{ PeriodCategory: 18, TeamID: '2479', Point: 69 }
		]
	};
}

test.describe('Japan B.League B1 Scraper & Pipeline Integration', () => {
	const league = 'bleague_test';
	const year = '2024'; // Realistic test year to avoid BaseNormalizer.isGameUnplayed future-dating

	/**
	 * @description Removes every artifact produced by this test run so assertions see a
	 * clean slate (raw payloads, transform cache, and the local test SQLite file).
	 * @returns {Promise<void>}
	 */
	async function cleanTestArtifacts() {
		await fs.rm(path.resolve('data/raw', league), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league), { recursive: true, force: true });
		await fs.rm(path.resolve('data/SQL/BLEAGUE_TEST.sqlite'), { force: true });
		await fs.rm(path.resolve('data/SQL/BLEAGUE_TEST.sqlite-wal'), { force: true });
		await fs.rm(path.resolve('data/SQL/BLEAGUE_TEST.sqlite-shm'), { force: true });
	}

	test.before(cleanTestArtifacts);
	test.after(cleanTestArtifacts);

	test('BLeagueHarvester should return mock slugs in test mode', async () => {
		const scraper = new BLeagueScraper();
		const slugs = await scraper.getSeasonGameSlugs('2024');

		assert.equal(slugs.length, 2, 'Should return exactly the two mock B1 games');
		assert.ok(slugs[0].includes('-BLEAGUE2024_'), 'Slugs must contain the B.League prefix segment');
		assert.match(slugs[0].split('-').pop(), /^BLEAGUE2024_\d+$/);
		assert.match(slugs[1].split('-').pop(), /^BLEAGUE2024_\d+$/);
		assert.ok(scraper.unplayedGameIds instanceof Set, 'Unplayed set must be propagated to the scraper');
		assert.equal(scraper.unplayedGameIds.size, 0, 'Mock games are final, so none are unplayed');
	});

	test('BLeagueHarvester.buildScheduleUrl should build the B1-only day-scoped schedule feed URL', () => {
		const harvester = new BLeagueHarvester();
		assert.equal(
			harvester.buildScheduleUrl(2024, 10, 1),
			'https://www.bleague.jp/schedule/?data_format=json&year=2024&mon=10&day=01&event=2&club=&tab=1&ha=&fb=&index=500'
		);
		assert.equal(
			harvester.buildScheduleUrl(2025, 3, 5),
			'https://www.bleague.jp/schedule/?data_format=json&year=2025&mon=03&day=05&event=2&club=&tab=1&ha=&fb=&index=500'
		);
	});

	test('BLeagueHarvester.parseFragment should parse played and unplayed schedule fragments', () => {
		const harvester = new BLeagueHarvester();

		const finalFragment = `
			<li class="list-item" id="506601">
				<a href="/game_detail/?ScheduleKey=506601&tab=1">
					<div class="team-name">NAGASAKI VELCA</div>
					<div class="team-name">SEAHORSES MIKAWA</div>
					<div class="info-scorestate"><span>FINAL</span></div>
				</a>
			</li>`;
		const finalGame = harvester.parseFragment(finalFragment, '2024-12-01', '2024');
		assert.ok(finalGame);
		assert.equal(finalGame.scheduleKey, '506601');
		assert.equal(finalGame.homeTeamName, 'NAGASAKI VELCA');
		assert.equal(finalGame.awayTeamName, 'SEAHORSES MIKAWA');
		assert.equal(finalGame.gameDate, '2024-12-01');
		assert.equal(finalGame.isFinal, true);
		assert.equal(finalGame.slug, 'NAGASAKI VELCA-vs-SEAHORSES MIKAWA-BLEAGUE2024_506601');

		// Unplayed fixture: no FINAL marker means isFinal stays false.
		const scheduledFragment = `
			<li class="list-item" id="506602">
				<a href="/game_detail/?ScheduleKey=506602&tab=1">
					<div class="team-name">CHIBA JETS</div>
					<div class="team-name">RYUKYU GOLDEN KINGS</div>
				</a>
			</li>`;
		const scheduledGame = harvester.parseFragment(scheduledFragment, '2027-01-15', '2026');
		assert.ok(scheduledGame);
		assert.equal(scheduledGame.scheduleKey, '506602');
		assert.equal(scheduledGame.isFinal, false);
		assert.match(scheduledGame.slug, /-BLEAGUE2026_506602$/);

		// Non-game fragments and invalid input must never produce a game record.
		assert.equal(harvester.parseFragment('<div>Nothing here</div>', '2024-12-01', '2024'), null);
		assert.equal(harvester.parseFragment('', '2024-12-01', '2024'), null);
		assert.equal(harvester.parseFragment(null, '2024-12-01', '2024'), null);
	});

	test('BLeagueHarvester should walk the season window and mark future non-FINAL fixtures as unplayed', async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		const scraper = { unplayedGameIds: null };
		const harvester = new BLeagueHarvester(scraper);
		harvester.requestDelayMs = 0; // Keep the ~366-day walk fast in tests

		const finalFragment = `
			<li class="list-item" id="900001">
				<a href="/game_detail/?ScheduleKey=900001&tab=1">
					<div class="team-name">CHIBA JETS</div>
					<div class="team-name">RYUKYU GOLDEN KINGS</div>
					<div class="info-scorestate"><span>FINAL</span></div>
				</a>
			</li>`;
		const scheduledFragment = `
			<li class="list-item" id="900002">
				<a href="/game_detail/?ScheduleKey=900002&tab=1">
					<div class="team-name">ALVARK TOKYO</div>
					<div class="team-name">UTSUNOMIYA BREX</div>
				</a>
			</li>`;

		/** @type {string[]} */
		const requestedUrls = [];
		harvester.request = async (url) => {
			requestedUrls.push(String(url));
			if (url.includes('year=2026&mon=10&day=10')) return { topics: [finalFragment] };
			if (url.includes('year=2026&mon=12&day=01')) return { topics: [scheduledFragment] };
			return { topics: [] };
		};

		try {
			const slugs = await harvester.getSeasonGameSlugs('2026');
			assert.equal(slugs.length, 2, 'Both discovered fixtures must be preserved');
			assert.ok(slugs.some(s => s.includes('-BLEAGUE2026_900001')));
			assert.ok(slugs.some(s => s.includes('-BLEAGUE2026_900002')));

			// Past FINAL game stays fetchable; future non-FINAL game is skipped.
			assert.deepEqual([...harvester.unplayedGameIds], ['900002']);
			assert.equal(scraper.unplayedGameIds, harvester.unplayedGameIds, 'Scraper must receive the unplayed set');

			// One request per calendar day across the Oct -> Sep season window.
			assert.ok(requestedUrls.length >= 365, `Expected a full season walk, got ${requestedUrls.length} requests`);
			assert.ok(requestedUrls.every(url => url.includes('tab=1')), 'Every schedule request must be B1-only');
		} finally {
			process.env.NODE_ENV = originalNodeEnv;
		}
	});

	test('BLeagueHarvester should reject non-numeric season years', async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		const harvester = new BLeagueHarvester();
		try {
			await assert.rejects(() => harvester.getSeasonGameSlugs('not-a-year'), /Invalid B.League season year/);
		} finally {
			process.env.NODE_ENV = originalNodeEnv;
		}
	});

	test('BLeagueScraper should parse unified game IDs and build official game_detail URLs', () => {
		const scraper = new BLeagueScraper();
		const parts = scraper.parseGameId('BLEAGUE2024_506601');
		assert.deepEqual(parts, {
			competitionId: 'bleague',
			seasonCode: '2024',
			gameCode: '506601',
			yearPrefix: '2024',
			scheduleKey: '506601'
		});
		assert.equal(scraper.getGameEndpoint('BLEAGUE2024_506601'), 'https://www.bleague.jp/game_detail/?ScheduleKey=506601&tab=1');
		assert.equal(scraper.getGameUrl('BLEAGUE2024_506601'), 'BLEAGUE2024_506601');
	});

	test('BLeagueScraper should return schema-compliant mock box scores in test mode', async () => {
		const scraper = new BLeagueScraper();

		// Game 1: NAGASAKI VELCA 86 - SEAHORSES MIKAWA 69
		const game1 = await scraper.request('BLEAGUE2024_20001');
		assert.equal(game1.gameId, 'BLEAGUE2024_20001');
		assert.equal(game1.season, '2024');
		assert.equal(game1.homeTeam.teamName, 'NAGASAKI VELCA');
		assert.equal(game1.homeTeam.score, 86);
		assert.equal(game1.awayTeam.teamName, 'SEAHORSES MIKAWA');
		assert.equal(game1.awayTeam.score, 69);

		const okada = game1.homeTeam.players.find(p => p.playerName === 'Sota Okada');
		assert.ok(okada);
		assert.equal(okada.playerId, '50001');
		assert.equal(okada.statistics.pts, 24);
		assert.equal(okada.statistics.min, '31:05');

		const jackson = game1.homeTeam.players.find(p => p.playerName === 'Leonard Jackson');
		assert.ok(jackson);
		assert.equal(jackson.statistics.pts, 15);
		assert.equal(jackson.statistics.min, '24:10');

		const kumagai = game1.awayTeam.players.find(p => p.playerName === 'Hayato Kumagai');
		assert.ok(kumagai);
		assert.equal(kumagai.statistics.pts, 19);
		assert.equal(kumagai.statistics.min, '30:50');
		assert.equal(validateSchema('bleague/boxscore.json', game1), true);

		// Game 2: SENDAI 89ERS 78 - YOKOHAMA B-CORSAIRS 85
		const game2 = await scraper.request('BLEAGUE2024_20002');
		assert.equal(game2.homeTeam.teamName, 'SENDAI 89ERS');
		assert.equal(game2.homeTeam.score, 78);
		assert.equal(game2.awayTeam.teamName, 'YOKOHAMA B-CORSAIRS');
		assert.equal(game2.awayTeam.score, 85);

		const ishida = game2.homeTeam.players.find(p => p.playerName === 'Kaito Ishida');
		assert.ok(ishida);
		assert.equal(ishida.statistics.pts, 17);
		assert.equal(ishida.statistics.min, '29:40');

		const murray = game2.awayTeam.players.find(p => p.playerName === 'Andre Murray');
		assert.ok(murray);
		assert.equal(murray.statistics.pts, 26);
		assert.equal(murray.statistics.min, '33:20');
		assert.equal(validateSchema('bleague/boxscore.json', game2), true);
	});

	test('BLeagueScraper should return an unplayed skeleton when no schedule key can be derived', async () => {
		const scraper = new BLeagueScraper();
		scraper.bypassNetwork = false; // Missing schedule key must fail before any network I/O
		const skeleton = await scraper.request('malformed-game-id');
		assert.equal(skeleton.homeTeam.teamName, 'Unplayed');
		assert.equal(skeleton.awayTeam.teamName, 'Unplayed');
		assert.deepEqual(skeleton.homeTeam.players, []);
		assert.deepEqual(skeleton.awayTeam.players, []);
		assert.equal(validateSchema('bleague/boxscore.json', skeleton), true);
	});

	test('BLeagueParser.parseGameDateTime should convert /Date(...) values to JST calendar dates', () => {
		assert.equal(parseGameDateTime('/Date(1733047200000+0900)/'), '2024-12-01');
		assert.equal(parseGameDateTime('/Date(1794909900000+0900)/'), '2026-11-17');
		assert.equal(parseGameDateTime('garbage'), '');
		assert.equal(parseGameDateTime('/Date(abc+0900)/'), '');
		assert.equal(parseGameDateTime(null), '');
		assert.equal(parseGameDateTime(''), '');
	});

	test('BLeagueParser.parseBLeaguePayload should select full-game rows and map unified statistics', () => {
		const boxscore = parseBLeaguePayload(buildGamePayload(), 'BLEAGUE2024_506601', '2024');

		assert.equal(boxscore.gameId, 'BLEAGUE2024_506601');
		assert.equal(boxscore.season, '2024');
		assert.equal(boxscore.gameDate, '2024-12-01');

		assert.equal(boxscore.homeTeam.teamId, 'NAGA');
		assert.equal(boxscore.homeTeam.teamName, 'NAGASAKI VELCA');
		assert.equal(boxscore.homeTeam.score, 86);
		assert.equal(boxscore.awayTeam.teamId, 'MIKA');
		assert.equal(boxscore.awayTeam.teamName, 'SEAHORSES MIKAWA');
		assert.equal(boxscore.awayTeam.score, 69);

		// Quarter/half partials, Category 2 fillers, and Category 3 totals are all excluded.
		assert.equal(boxscore.homeTeam.players.length, 6, 'Only full-game player rows survive');
		assert.ok(boxscore.homeTeam.players.every(p => p.playerId !== ''), 'Blank filler rows must be excluded');
		const okada = boxscore.homeTeam.players.find(p => p.playerId === '50001');
		assert.ok(okada);
		assert.equal(okada.statistics.pts, 24, 'Full-game total, not the quarter/half partial');
		assert.equal(okada.statistics.fgm, 9);
		assert.equal(okada.statistics.fga, 16);
		assert.equal(okada.statistics.fg3m, 3);
		assert.equal(okada.statistics.fg3a, 7);
		assert.equal(okada.statistics.ftm, 3);
		assert.equal(okada.statistics.fta, 4);
		assert.equal(okada.statistics.oreb, 1);
		assert.equal(okada.statistics.dreb, 4);
		assert.equal(okada.statistics.reb, 5);
		assert.equal(okada.statistics.ast, 7);
		assert.equal(okada.statistics.stl, 2);
		assert.equal(okada.statistics.blk, 0);
		assert.equal(okada.statistics.tov, 3);
		assert.equal(okada.statistics.pf, 2);
		assert.equal(okada.statistics.plus_minus, 14);
		assert.equal(okada.statistics.min, '31:05');

		const dnp = boxscore.homeTeam.players.find(p => p.playerId === '50014');
		assert.ok(dnp);
		assert.equal(dnp.statistics.min, 'DNP', 'Non-MM:SS PlayTime values pass through untouched');
		assert.equal(dnp.statistics.pts, 0);

		// Every full-game player appears exactly once (no period bleed-through).
		const homeIds = boxscore.homeTeam.players.map(p => p.playerId);
		assert.equal(new Set(homeIds).size, homeIds.length, 'Players must not repeat across periods');

		assert.equal(boxscore.awayTeam.players.length, 4);
		const kumagai = boxscore.awayTeam.players.find(p => p.playerId === '50005');
		assert.ok(kumagai);
		assert.equal(kumagai.statistics.pts, 19);
		assert.equal(kumagai.statistics.fgm, 8);
		assert.equal(kumagai.statistics.fg3m, 2);
		assert.equal(kumagai.statistics.min, '30:50');
		assert.equal(kumagai.statistics.plus_minus, -14);

		assert.equal(validateSchema('bleague/boxscore.json', boxscore), true);
	});

	test('BLeagueParser.parseBLeaguePayload should return skeletons for unplayed and boxscore-less games', () => {
		const payload = buildGamePayload();

		// Not finished: never expose partial statistics.
		const live = parseBLeaguePayload(
			{ ...payload, Game: { ...payload.Game, GameEndedFlg: false } },
			'BLEAGUE2024_506601',
			'2024'
		);
		assert.equal(live.homeTeam.teamName, 'Unplayed');
		assert.deepEqual(live.homeTeam.players, []);
		assert.deepEqual(live.awayTeam.players, []);

		// Missing Game header entirely.
		const headerless = parseBLeaguePayload({ HomeBoxscores: [], AwayBoxscores: [] }, 'BLEAGUE2024_506601', '2024');
		assert.equal(headerless.homeTeam.teamName, 'Unplayed');
		assert.deepEqual(headerless.homeTeam.players, []);

		// Ended game without box score rows (e.g. exhibition games): keep real team names/scores.
		const noBoxscore = parseBLeaguePayload(
			{ Game: payload.Game, HomeBoxscores: [], AwayBoxscores: [] },
			'BLEAGUE2024_506601',
			'2024'
		);
		assert.equal(noBoxscore.homeTeam.teamName, 'NAGASAKI VELCA');
		assert.equal(noBoxscore.homeTeam.score, 86);
		assert.equal(noBoxscore.awayTeam.teamName, 'SEAHORSES MIKAWA');
		assert.deepEqual(noBoxscore.homeTeam.players, []);
		assert.equal(noBoxscore.gameDate, '2024-12-01');

		// createUnplayedSkeleton (exported) keeps the unified shape.
		const skeleton = createUnplayedSkeleton('BLEAGUE2024_999999', '2024');
		assert.equal(skeleton.gameId, 'BLEAGUE2024_999999');
		assert.equal(validateSchema('bleague/boxscore.json', skeleton), true);

		// Non-object payloads are programming errors and must throw.
		assert.throws(() => parseBLeaguePayload(null, 'BLEAGUE2024_506601', '2024'), /is not an object/);
		assert.throws(() => parseBLeaguePayload('nope', 'BLEAGUE2024_506601', '2024'), /is not an object/);
		assert.throws(() => parseBLeaguePayload([], 'BLEAGUE2024_506601', '2024'), /is not an object/);
	});

	test('BLeagueParser.extractEmbeddedPayload should recover the payload from game_detail HTML', () => {
		const payload = buildGamePayload();
		const html = `<html><body><script>var other = {};</script><script>_contexts_s3id.data = ${JSON.stringify(payload)};</script></body></html>`;
		const extracted = extractEmbeddedPayload(html);
		assert.ok(extracted);
		assert.equal(extracted.Game.HomeTeamScore, 86);
		assert.equal(extracted.Game.StadiumNameE, 'Arena } { "Quoted" Stadium', 'Braces/quotes inside strings must not break scanning');
		assert.equal(extracted.HomeBoxscores.length, payload.HomeBoxscores.length);

		// A non-object first occurrence must be skipped in favor of a later valid assignment.
		const nullFirst = `_contexts_s3id.data = null; _contexts_s3id.data = ${JSON.stringify({ ok: 1 })};`;
		assert.deepEqual(extractEmbeddedPayload(nullFirst), { ok: 1 });

		// No anchor, malformed payload, and non-string input all yield null.
		assert.equal(extractEmbeddedPayload('<html><body>No embed here</body></html>'), null);
		assert.equal(extractEmbeddedPayload('_contexts_s3id.data = {broken'), null);
		assert.equal(extractEmbeddedPayload(''), null);
		assert.equal(extractEmbeddedPayload(null), null);
	});

	test('extractStage should skip unplayed B.League fixtures before scraper.request', async () => {
		let requestCalls = 0;
		const scraper = {
			gameSlugs: [],
			unplayedGameIds: new Set(['20003']),
			async getSeasonGameSlugs() {
				this.gameSlugs = ['nagasaki-velca-vs-seahorses-mikawa-BLEAGUE2024_20003'];
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
		assert.deepEqual(gameIds, ['BLEAGUE2024_20003']);
		assert.equal(requestCalls, 0, 'Unplayed fixtures must be skipped before any game-page access');

		const filePath = path.resolve('data/raw', league, year, 'BLEAGUE2024_20003.json');
		await assert.rejects(() => fs.stat(filePath), 'No raw cache file may be written for an unplayed fixture');
	});

	test('transformBLeague should skip unplayed skeletons and surface unreadable directories', async () => {
		// Missing directory: warn + empty result rather than crashing.
		const missing = await transformBLeague(path.resolve('data/raw', league, 'does-not-exist'), year);
		assert.deepEqual(missing, { players: [], teams: [] });

		// Unplayed skeleton files are dropped instead of transformed.
		const unitDir = path.resolve('data/raw', league, 'unit_transform');
		await fs.mkdir(unitDir, { recursive: true });
		try {
			await fs.writeFile(
				path.join(unitDir, 'BLEAGUE2024_90009.json'),
				JSON.stringify(createUnplayedSkeleton('BLEAGUE2024_90009', year)),
				'utf8'
			);
			const skipped = await transformBLeague(unitDir, year);
			assert.deepEqual(skipped, { players: [], teams: [] });

			// Malformed JSON must reject instead of silently dropping data.
			await fs.writeFile(path.join(unitDir, 'broken.json'), '{ not valid json', 'utf8');
			await assert.rejects(() => transformBLeague(unitDir, year));
		} finally {
			await fs.rm(unitDir, { recursive: true, force: true });
		}
	});

	test('2-transform should only dispatch B.League to its league-owned transform file', async () => {
		const stageSource = await fs.readFile(path.resolve('src/stages/2-transform.mjs'), 'utf8');
		assert.ok(stageSource.includes('../scrapers/bleague/bleague_transform.mjs'), 'Stage must import the league-owned transform');
		assert.ok(stageSource.includes('transformBLeague(rawDir, year)'), 'Stage must dispatch to transformBLeague');
		assert.ok(!stageSource.includes('bleagueMappings'), 'No league-specific mapping loader may live in the general stage');
		assert.ok(!stageSource.includes('config/bleague_team_mappings.json'), 'League config must be owned by the league transform');
	});

	test('Full Japan B.League Pipeline Integration: Extract -> Transform -> Load', async () => {
		// 1. STAGE 1: Extract (test mode serves mock official payloads)
		const scraper = new BLeagueScraper();
		const gameIds = await extractStage(scraper, league, year);
		assert.ok(gameIds.includes('BLEAGUE2024_20001'));
		assert.ok(gameIds.includes('BLEAGUE2024_20002'));

		const rawFiles = await fs.readdir(path.resolve('data/raw', league, year));
		assert.ok(rawFiles.includes('BLEAGUE2024_20001.json'));
		assert.ok(rawFiles.includes('BLEAGUE2024_20002.json'));

		// 2. STAGE 2: Transform (league-owned bleague_transform.mjs)
		const transformed = await transformStage(league, year);
		assert.equal(transformed.players.length, 9, '5 players + 4 Team/Bench variance rows');
		assert.equal(transformed.teams.length, 4, 'One team row per game side');

		const okada = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20001' && p.player_id === '50001');
		assert.ok(okada);
		assert.equal(okada.team_id, 'nagasaki-velca'); // mapped via config/bleague_team_mappings.json
		assert.equal(okada.player_name, 'Sota Okada');
		assert.equal(okada.pts, 24);
		assert.equal(okada.min, '31.1'); // "31:05" -> 31.1 minutes
		assert.equal(okada.fgm, 9);
		assert.equal(okada.fg3m, 3);
		assert.equal(okada.plus_minus, 14);
		assert.equal(okada.season, '2024');
		assert.equal(okada.league, 'bleague');

		const jackson = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20001' && p.player_id === '50002');
		assert.ok(jackson);
		assert.equal(jackson.team_id, 'nagasaki-velca');
		assert.equal(jackson.min, '24.2'); // "24:10" -> 24.2 minutes

		const murray = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20002' && p.player_id === '50004');
		assert.ok(murray);
		assert.equal(murray.team_id, 'yokohama-b-corsairs');
		assert.equal(murray.pts, 26);
		assert.equal(murray.min, '33.3'); // "33:20" -> 33.3 minutes

		const ishida = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20002' && p.player_id === '50003');
		assert.ok(ishida);
		assert.equal(ishida.team_id, 'sendai-89ers');
		assert.equal(ishida.pts, 17);
		assert.equal(ishida.min, '29.7'); // "29:40" -> 29.7 minutes

		// Points variance reconciliation keeps the official team score authoritative.
		const varianceRows = transformed.players.filter(p => p.player_name === 'Team/Bench');
		assert.equal(varianceRows.length, 4, 'One reconciliation row per team with a points variance');
		const nagasakiVariance = varianceRows.find(p => p.game_id === 'BLEAGUE2024_20001' && p.team_id === 'nagasaki-velca');
		assert.ok(nagasakiVariance);
		assert.equal(nagasakiVariance.pts, 47); // 86 official - 39 player sum
		assert.equal(nagasakiVariance.player_id, 'nagasaki-velca_team');
		assert.equal(nagasakiVariance.comment, 'Points Variance Reconciliation');
		const mikawaVariance = varianceRows.find(p => p.game_id === 'BLEAGUE2024_20001' && p.team_id === 'seahorses-mikawa');
		assert.ok(mikawaVariance);
		assert.equal(mikawaVariance.pts, 50); // 69 official - 19 player sum

		// Team rows carry official scores and league rollup tags.
		const teamIds = transformed.teams.map(t => t.team_id).sort();
		assert.deepEqual(teamIds, ['nagasaki-velca', 'seahorses-mikawa', 'sendai-89ers', 'yokohama-b-corsairs']);
		const nagasakiTeam = transformed.teams.find(t => t.game_id === 'BLEAGUE2024_20001' && t.team_id === 'nagasaki-velca');
		assert.ok(nagasakiTeam);
		assert.equal(nagasakiTeam.pts, 86);
		assert.equal(nagasakiTeam.plus_minus, 17); // 86 - 69
		assert.equal(nagasakiTeam.fgm, 15, 'Team totals aggregate player statistics');
		assert.equal(nagasakiTeam.league, 'bleague');
		assert.ok(transformed.teams.every(t => t.league === 'bleague'));

		// 3. STAGE 3: Load
		await loadStage(league, year, transformed);

		// 4. Verify in the local staging database
		const db = await initDatabase(league);
		try {
			const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('bleague', year);
			assert.equal(playerStats.length, 9, 'All player + reconciliation rows must land in the database');
			assert.ok(playerStats.every(p => p.league === 'bleague'), 'Rows must be tagged with the standalone league key');

			const dbOkada = playerStats.find(p => p.game_id === 'BLEAGUE2024_20001' && String(p.player_id) === '50001');
			assert.ok(dbOkada);
			assert.equal(dbOkada.pts, 24);
			assert.equal(dbOkada.min, '31.1');
			assert.equal(dbOkada.team_id, 'nagasaki-velca');
			assert.equal(dbOkada.normalized_name, 'Sota Okada');
			assert.ok(dbOkada.game_score > 0, 'game_score should be derived');

			assert.ok(playerStats.some(p => p.player_name === 'Team/Bench' && p.team_id === 'nagasaki-velca' && p.pts === 47));

			const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('bleague', year);
			assert.equal(teamStats.length, 4);
			assert.ok(teamStats.some(t => t.team_id === 'nagasaki-velca' && t.pts === 86));
			assert.ok(teamStats.some(t => t.team_id === 'seahorses-mikawa' && t.pts === 69));
			assert.ok(teamStats.some(t => t.team_id === 'sendai-89ers' && t.pts === 78));
			assert.ok(teamStats.some(t => t.team_id === 'yokohama-b-corsairs' && t.pts === 85));

			// B.League must never bleed back into the Asia rollup database.
			const strayRows = db.prepare("SELECT COUNT(*) AS n FROM player_game_stats WHERE game_id LIKE 'BLEAGUE%' AND league != 'bleague'").get();
			assert.equal(strayRows.n, 0);
		} finally {
			db.close();
		}
	});
});
