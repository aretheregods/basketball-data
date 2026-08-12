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
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
