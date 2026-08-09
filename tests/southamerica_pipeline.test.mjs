process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SouthAmericaScraper } from '../src/scrapers/southamerica/SouthAmericaScraper.mjs';
import { SouthAmericaHarvester } from '../src/scrapers/southamerica/harvesters/SouthAmericaHarvester.mjs';
import { parseSouthAmericaHtml } from '../src/scrapers/southamerica/parsers/SouthAmericaParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('South America BCLA Scraper & Pipeline Integration', () => {
	const league = 'southamerica_test';
	const year = '2024'; // Unique test year to isolate test runs

	test.before(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('SouthAmericaHarvester should return mock slugs in test mode', async () => {
		const harvester = new SouthAmericaHarvester();
		harvester.scraper = { bypassNetwork: true };
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-SA2024_'), 'Slugs must contain SA segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^SA2024_\d+$/, 'gameId Segment must match South America pattern');
	});

	test('SouthAmericaScraper should return correct unified schema mock data', async () => {
		const scraper = new SouthAmericaScraper();
		const boxscore = await scraper.request('flamengo-vs-quimsa-SA2024_10001');

		assert.equal(boxscore.gameId, 'flamengo-vs-quimsa-SA2024_10001');
		assert.equal(boxscore.season, '2024');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'FLAMENGO');
		assert.equal(boxscore.homeTeam.score, 88);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const galvanini = boxscore.homeTeam.players.find(p => p.playerName.includes('Gabriel Galvanini'));
		assert.ok(galvanini);
		assert.equal(galvanini.playerId, 'gabriel-galvanini');
		assert.equal(galvanini.statistics.pts, 18);
		assert.equal(galvanini.statistics.min, '28:30');
	});

	test('SouthAmericaScraper HTML Parser should correctly parse South America team names, scores, and player statistics from Proballers HTML', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>FLAMENGO</span>
					<div class="score">88 vs 82</div>
					<span>QUIMSA</span>
				</div>

				<div class="stats-section">
					<h2>FLAMENGO</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Gabriel Galvanini</td>
								<td>28:30</td>
								<td>7</td>
								<td>11</td>
								<td>1</td>
								<td>2</td>
								<td>3</td>
								<td>4</td>
								<td>3</td>
								<td>6</td>
								<td>9</td>
								<td>4</td>
								<td>1</td>
								<td>2</td>
								<td>1</td>
								<td>2</td>
								<td>18</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>32</td>
								<td>62</td>
								<td>6</td>
								<td>18</td>
								<td>18</td>
								<td>24</td>
								<td>12</td>
								<td>28</td>
								<td>40</td>
								<td>16</td>
								<td>6</td>
								<td>4</td>
								<td>10</td>
								<td>18</td>
								<td>88</td>
							</tr>
						</tbody>
					</table>

					<h2>QUIMSA</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Brandon Robinson</td>
								<td>32:15</td>
								<td>8</td>
								<td>16</td>
								<td>3</td>
								<td>6</td>
								<td>2</td>
								<td>2</td>
								<td>1</td>
								<td>4</td>
								<td>5</td>
								<td>3</td>
								<td>2</td>
								<td>0</td>
								<td>3</td>
								<td>3</td>
								<td>21</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>30</td>
								<td>64</td>
								<td>8</td>
								<td>22</td>
								<td>14</td>
								<td>18</td>
								<td>8</td>
								<td>22</td>
								<td>30</td>
								<td>12</td>
								<td>8</td>
								<td>2</td>
								<td>14</td>
								<td>20</td>
								<td>82</td>
							</tr>
						</tbody>
					</table>
				</div>
			</body>
			</html>
		`;

		const boxscore = parseSouthAmericaHtml(sampleHtml, 'flamengo', 'quimsa', 'flamengo-vs-quimsa-SA2024_10001', '2024');

		assert.equal(boxscore.homeTeam.teamName, 'FLAMENGO');
		assert.equal(boxscore.awayTeam.teamName, 'QUIMSA');
		assert.equal(boxscore.homeTeam.score, 88);
		assert.equal(boxscore.awayTeam.score, 82);

		const galvanini = boxscore.homeTeam.players.find(p => p.playerName === 'Gabriel Galvanini');
		assert.ok(galvanini, 'Should parse Gabriel Galvanini successfully');
		assert.equal(galvanini.statistics.pts, 18);
		assert.equal(galvanini.statistics.min, '28:30');

		const robinson = boxscore.awayTeam.players.find(p => p.playerName === 'Brandon Robinson');
		assert.ok(robinson, 'Should parse Brandon Robinson successfully');
		assert.equal(robinson.statistics.pts, 21);
		assert.equal(robinson.statistics.min, '32:15');
	});

	test('Full South America Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new SouthAmericaScraper();

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('SA2024_10001'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const galvanini = transformed.players.find(p => p.player_id === 'gabriel-galvanini');
			assert.ok(galvanini);
			assert.equal(galvanini.team_id, 'flamengo'); // resolved team ID from config/southamerica_team_mappings.json
			assert.equal(galvanini.pts, 18);
			assert.equal(galvanini.min, '28.5'); // "28:30" parses to 28.5 minutes

			const robinson = transformed.players.find(p => p.player_id === 'brandon-robinson');
			assert.ok(robinson);
			assert.equal(robinson.team_id, 'quimsa'); // resolved team ID
			assert.equal(robinson.pts, 21);
			assert.equal(robinson.min, '32.3'); // "32:15" parses to 32.3 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('southamerica', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Gabriel Galvanini'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('southamerica', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'FLAMENGO'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
