import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { AcbEngine } from '../src/scrapers/europe/engines/AcbEngine.mjs';
import { AcbHarvester } from '../src/scrapers/europe/harvesters/AcbHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

// Global fetch mocking helper
let fetchMock = null;
const originalFetch = globalThis.fetch;

test.before(async () => {
	process.env.NODE_ENV = 'test';
	globalThis.fetch = async (url, config) => {
		if (fetchMock) {
			return fetchMock(url, config);
		}
		return originalFetch(url, config);
	};
});

test.after(async () => {
	globalThis.fetch = originalFetch;
});

test.beforeEach(() => {
	fetchMock = null;
});

test.describe('ACB (Liga Endesa) Scraper & Pipeline Integration', () => {
	const league = 'europe';
	const year = '2098'; // Unique test year to isolate test runs

	test('AcbHarvester should fetch calendar and extract slugs correctly', async () => {
		const harvester = new AcbHarvester();

		// Read our local real fixture file `test_calendar.html`
		const calendarHtml = await fs.readFile(path.join(PROJECT_ROOT, 'test_calendar.html'), 'utf8');

		fetchMock = async (url, config) => {
			assert.match(url, /\/es\/liga\/calendario/);
			return {
				ok: true,
				status: 200,
				text: async () => calendarHtml
			};
		};

		const slugs = await harvester.getSeasonGameSlugs('2098');
		assert.ok(slugs.length > 0, 'Should extract some slugs');
		// Example slug format: matchups-Aseason_gameId
		assert.ok(slugs[0].includes('-A2098_'), 'Slugs must be formatted with A season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^A2098_\d+$/, 'gameId Segment must match ACB pattern');
	});

	test('AcbEngine should fetch statistics, parse push data and return unified schema', async () => {
		const engine = new AcbEngine();
		const matchHtml = await fs.readFile(path.join(PROJECT_ROOT, 'test_acb.html'), 'utf8');

		fetchMock = async (url, config) => {
			assert.match(url, /\/es\/partidos\/105373\/estadisticas/);
			return {
				ok: true,
				status: 200,
				text: async () => matchHtml
			};
		};

		// Set NODE_ENV to production temporarily so getUnifiedBoxScore doesn't trigger mock data
		process.env.NODE_ENV = 'production';
		try {
			const boxscore = await engine.getUnifiedBoxScore('A2098_105373');

			assert.equal(boxscore.gameId, 'A2098_105373');
			assert.equal(boxscore.competitionId, 'acb');
			assert.equal(boxscore.seasonId, '2098');
			assert.equal(boxscore.gameDate, '2026-06-24');

			// Home Team Barça verification
			assert.equal(boxscore.homeTeam.teamName, 'Barça');
			assert.equal(boxscore.homeTeam.teamId, 'BAR');
			assert.equal(boxscore.homeTeam.score, 84);
			assert.ok(boxscore.homeTeam.players.length > 0);

			// Away Team Valencia Basket verification
			assert.equal(boxscore.awayTeam.teamName, 'Valencia Basket');
			assert.equal(boxscore.awayTeam.teamId, 'VBC');
			assert.equal(boxscore.awayTeam.score, 108);
			assert.ok(boxscore.awayTeam.players.length > 0);

			// Player stat verification (e.g. Kevin Punter)
			const punter = boxscore.homeTeam.players.find(p => p.playerName.includes('Punter'));
			assert.ok(punter);
			assert.equal(punter.playerId, '30003361');
			assert.equal(punter.statistics.pts, 26);
			assert.equal(punter.statistics.min, '34:13');

			// Team aggregate stat verification
			assert.equal(boxscore.homeTeam.statistics.fgm, 27);
			assert.equal(boxscore.homeTeam.statistics.fg3m, 14);
		} finally {
			process.env.NODE_ENV = 'test';
		}
	});

	test('EuropeScraper should route gameId prefixed with A to AcbEngine', () => {
		const scraper = new EuropeScraper({ competitions: 'acb' });
		const engine = scraper.getEngineForGame('A2098_105373');
		assert.ok(engine instanceof AcbEngine);
	});

	test('Full ACB Pipeline Integration: Extract -> Transform -> Load', async () => {
		const scraper = new EuropeScraper({ competitions: 'acb' });

		// Mock harvester & engine response
		const calendarHtml = await fs.readFile(path.join(PROJECT_ROOT, 'test_calendar.html'), 'utf8');
		const matchHtml = await fs.readFile(path.join(PROJECT_ROOT, 'test_acb.html'), 'utf8');

		fetchMock = async (url, config) => {
			if (url.includes('/es/liga/calendario')) {
				return { ok: true, status: 200, text: async () => calendarHtml };
			}
			if (url.includes('/estadisticas')) {
				return { ok: true, status: 200, text: async () => matchHtml };
			}
			return { ok: false, status: 404 };
		};

		// 1. STAGE 1: Extract
		const gameIds = await extractStage(scraper, league, year);
		assert.ok(gameIds.length > 0);
		assert.ok(gameIds.includes('A2098_105373'));

		// 2. STAGE 2: Transform
		const transformed = await transformStage(league, year);
		assert.ok(transformed.players.length > 0);
		assert.ok(transformed.teams.length > 0);

		// Assert transformed records
		const kp = transformed.players.find(p => p.player_id === 'kevin-punter');
		assert.ok(kp);
		assert.equal(kp.team_id, 'fc-barcelona');
		assert.equal(kp.pts, 26);
		assert.equal(kp.min, '34.2'); // "34:13" parses to 34.2 minutes

		// 3. STAGE 3: Load
		await loadStage(league, year, transformed);

		// 4. Verify in Database
		const db = await initDatabase(league);
		try {
			const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('acb', year);
			assert.ok(playerStats.length > 0);
			assert.ok(playerStats.some(p => p.player_name === 'Kevin Punter'));

			const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('acb', year);
			assert.ok(teamStats.length > 0);
			assert.ok(teamStats.some(t => t.team_name === 'Barça'));

			const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('acb', year);
			assert.ok(games.length > 0);
			assert.ok(games.some(g => g.id === 'A2098_105373'), 'Should save the targeted final game');
		} finally {
			db.destroy();
		}

		// Cleanup files generated in this test
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});
});
