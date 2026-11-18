process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { NblScraper } from '../src/scrapers/nbl/NblScraper.mjs';
import { NblHarvester } from '../src/scrapers/nbl/harvesters/NblHarvester.mjs';
import { parseNblHtml } from '../src/scrapers/nbl/parsers/NblParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Oceania NBL Scraper & Pipeline Integration', () => {
	const league = 'nbl_test';
	const year = '2024'; // Unique test year to isolate test runs

	test.before(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('NblHarvester should return mock slugs in test mode', async () => {
		const harvester = new NblHarvester();
		harvester.scraper = { bypassNetwork: true };
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-O2024_'), 'Slugs must contain Oceania prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^O2024_\d+$/, 'gameId Segment must match NBL pattern');
	});

	test('NblHarvester should preserve all discovered IDs and mark explicitly scheduled games', async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		const harvester = new NblHarvester();
		harvester.scraper = { setGameUrl() {} };
		const originalFetch = globalThis.fetch;
		let calls = 0;
		const requestedUrls = [];
		globalThis.fetch = async url => {
			calls += 1;
			requestedUrls.push(String(url));
			return {
				ok: true,
				json: async () => ({ data: [
					{ id: 21, match_slug: 'played-match', match_status: 'FINALIZED', home_team: { team_code: 'MEL' }, away_team: { team_code: 'SYD' } },
					{ id: 22, match_slug: 'scheduled-match', match_status: 'SCHEDULED', start_time_datetime: '2099-01-01T10:00:00Z', home_team: { team_code: 'MEL' }, away_team: { team_code: 'SYD' } },
					{ id: 25, match_slug: 'stale-scheduled-match', match_status: 'SCHEDULED', start_time_datetime: new Date(Date.now() - 86400000).toISOString(), home_team: { team_code: 'MEL' }, away_team: { team_code: 'SYD' } },
					{ id: 23, match_slug: 'scored-match', home_team_score: 80, away_team_score: 75 },
					{ id: 24, match_slug: 'zero-score-match', home_team_score: 0, away_team_score: 0 }
				] })
			};
		};
		try {
			const slugs = await harvester.getSeasonGameSlugs('2026');
			assert.deepEqual(slugs, ['played-match-O2026_21', 'scheduled-match-O2026_22', 'stale-scheduled-match-O2026_25', 'scored-match-O2026_23', 'zero-score-match-O2026_24']);
			assert.deepEqual([...harvester.scraper.unplayedGameIds], ['22']);
			assert.equal(calls, 2, 'should merge the all-games and regular-season schedules');
			assert.ok(requestedUrls.every(url => url.endsWith('?limit=500')), 'schedule requests should ask for a full season page');
		} finally {
			globalThis.fetch = originalFetch;
			process.env.NODE_ENV = originalNodeEnv;
		}
	});

	test('extractStage should skip explicitly scheduled NBL games before scraper.request', async () => {
		const scraper = {
			gameSlugs: [],
			unplayedGameIds: new Set(['10003']),
			async getSeasonGameSlugs() {
				this.gameSlugs = ['melbourne-united-vs-sydney-kings-O2024_10003'];
			},
			getGameEndpoint() { throw new Error('request should be skipped'); },
			getGameUrl() { throw new Error('request should be skipped'); },
			async request() { throw new Error('request should be skipped'); }
		};
		const gameIds = await extractStage(scraper, 'nbl_test', '2024');
		assert.deepEqual(gameIds, ['O2024_10003']);
	});

	test('NblScraper should return correct unified schema mock data', async () => {
		const scraper = new NblScraper();
		const boxscore = await scraper.request('melbourne-united-vs-sydney-kings-O2024_10001');

		assert.equal(boxscore.gameId, 'melbourne-united-vs-sydney-kings-O2024_10001');
		assert.equal(boxscore.season, '2024');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'MELBOURNE UNITED');
		assert.equal(boxscore.homeTeam.score, 98);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const chrisGoulding = boxscore.homeTeam.players.find(p => p.playerName.includes('Chris Goulding'));
		assert.ok(chrisGoulding);
		assert.equal(chrisGoulding.playerId, 'chris-goulding');
		assert.equal(chrisGoulding.statistics.pts, 21);
		assert.equal(chrisGoulding.statistics.min, '28:15');
	});

	test('NblScraper should normalize official Rosetta player boxscore statistics', () => {
		const scraper = new NblScraper();
		const match = {
			start_time_datetime: '2026-11-15T04:00:00',
			home_score: '111', away_score: '102',
			home_team: { id: 'home-id', team_code: 'SYD', name: 'Sydney Kings' },
			away_team: { id: 'away-id', team_code: 'NZL', name: 'NZ Breakers' },
			player_match_statistics: [
				{ period: '0', participated: true, player: { id: 'p1', full_name: 'Home Player' }, team: { id: 'home-id' }, minutes: '15:36', points: 12, field_goals_made: 4, field_goals_attempted: 8, three_points_made: 2, three_points_attempted: 4, free_throws_made: 2, free_throws_attempted: 2, offensive_rebounds: 1, defensive_rebounds: 3, rebounds: 4, assists: 2, steals: 1, blocks: 0, turnovers: 1, fouls: 2 },
				{ period: '0', participated: true, player: { id: 'p2', full_name: 'Away Player' }, team: { id: 'away-id' }, minutes: '20:00', points: 9 }
			]
		};
		const result = scraper.normalizeRosettaBoxScore('O2026_match-uuid', '2026', match);
		assert.equal(result.gameDate, '2026-11-15');
		assert.equal(result.homeTeam.score, 111);
		assert.equal(result.homeTeam.players[0].statistics.pts, 12);
		assert.equal(result.homeTeam.players[0].statistics.fg3m, 2);
		assert.equal(result.awayTeam.players[0].playerName, 'Away Player');
	});

	test('NblScraper HTML Parser should correctly parse NBL team names, scores, and player statistics from Proballers HTML', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>MELBOURNE UNITED</span>
					<div class="score">98 vs 92</div>
					<span>SYDNEY KINGS</span>
				</div>

				<div class="stats-section">
					<h2>MELBOURNE UNITED</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Chris Goulding</td>
								<td>28:15</td>
								<td>7</td>
								<td>14</td>
								<td>5</td>
								<td>10</td>
								<td>2</td>
								<td>2</td>
								<td>0</td>
								<td>3</td>
								<td>3</td>
								<td>4</td>
								<td>1</td>
								<td>0</td>
								<td>2</td>
								<td>2</td>
								<td>21</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>36</td>
								<td>70</td>
								<td>12</td>
								<td>28</td>
								<td>14</td>
								<td>18</td>
								<td>8</td>
								<td>24</td>
								<td>32</td>
								<td>18</td>
								<td>6</td>
								<td>2</td>
								<td>10</td>
								<td>15</td>
								<td>98</td>
							</tr>
						</tbody>
					</table>

					<h2>SYDNEY KINGS</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Jaylen Adams</td>
								<td>32:10</td>
								<td>9</td>
								<td>18</td>
								<td>3</td>
								<td>7</td>
								<td>4</td>
								<td>5</td>
								<td>1</td>
								<td>4</td>
								<td>5</td>
								<td>7</td>
								<td>2</td>
								<td>1</td>
								<td>3</td>
								<td>3</td>
								<td>25</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>33</td>
								<td>68</td>
								<td>10</td>
								<td>24</td>
								<td>16</td>
								<td>20</td>
								<td>6</td>
								<td>22</td>
								<td>28</td>
								<td>15</td>
								<td>5</td>
								<td>1</td>
								<td>12</td>
								<td>18</td>
								<td>92</td>
							</tr>
						</tbody>
					</table>
				</div>
			</body>
			</html>
		`;

		const boxscore = parseNblHtml(sampleHtml, 'melbourne-united', 'sydney-kings', 'melbourne-united-vs-sydney-kings-O2024_10001', '2024');

		assert.equal(boxscore.homeTeam.teamName, 'MELBOURNE UNITED');
		assert.equal(boxscore.awayTeam.teamName, 'SYDNEY KINGS');
		assert.equal(boxscore.homeTeam.score, 98);
		assert.equal(boxscore.awayTeam.score, 92);

		const goulding = boxscore.homeTeam.players.find(p => p.playerName === 'Chris Goulding');
		assert.ok(goulding, 'Should parse Chris Goulding successfully');
		assert.equal(goulding.statistics.pts, 21);
		assert.equal(goulding.statistics.min, '28:15');

		const adams = boxscore.awayTeam.players.find(p => p.playerName === 'Jaylen Adams');
		assert.ok(adams, 'Should parse Jaylen Adams successfully');
		assert.equal(adams.statistics.pts, 25);
		assert.equal(adams.statistics.min, '32:10');
	});

	test('Full Oceania Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new NblScraper();

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('O2024_10001'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const goulding = transformed.players.find(p => p.player_id === 'chris-goulding');
			assert.ok(goulding);
			assert.equal(goulding.team_id, 'melbourne-united'); // resolved team ID from config/nbl_team_mappings.json
			assert.equal(goulding.pts, 21);
			assert.equal(goulding.min, '28.3'); // "28:15" parses to 28.3 minutes

			const adams = transformed.players.find(p => p.player_id === 'jaylen-adams');
			assert.ok(adams);
			assert.equal(adams.team_id, 'sydney-kings'); // resolved team ID
			assert.equal(adams.pts, 25);
			assert.equal(adams.min, '32.2'); // "32:10" parses to 32.2 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('nbl', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Chris Goulding'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('nbl', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'MELBOURNE UNITED'));
			} finally {
				db.close();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
