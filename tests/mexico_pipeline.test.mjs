import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { LnbpScraper } from '../src/scrapers/mexico/LnbpScraper.mjs';
import { LnbpHarvester } from '../src/scrapers/mexico/harvesters/LnbpHarvester.mjs';
import { parseLnbpHtml } from '../src/scrapers/mexico/parsers/LnbpParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('Mexico LNBP Scraper & Pipeline Integration', () => {
	const league = 'mexico_test';
	const year = '2099'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('LnbpHarvester should return mock slugs in test mode', async () => {
		const harvester = new LnbpHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2099');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-M2099_'), 'Slugs must be formatted with M segment segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^M2099_\d+$/, 'gameId Segment must match Mexico pattern');
	});

	test('LnbpScraper should return correct unified schema mock data', async () => {
		const scraper = new LnbpScraper();
		const boxscore = await scraper.request('fuerza-regia-vs-astros-de-jalisco-M2099_890123');

		assert.equal(boxscore.gameId, 'fuerza-regia-vs-astros-de-jalisco-M2099_890123');
		assert.equal(boxscore.season, '2099');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'FUERZA REGIA');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const quinones = boxscore.homeTeam.players.find(p => p.playerName.includes('Quiñones'));
		assert.ok(quinones);
		assert.equal(quinones.playerId, 'julian-quinones');
		assert.equal(quinones.statistics.pts, 14);
		assert.equal(quinones.statistics.min, '28:15');
	});

	test('LnbpScraper HTML Parser should correctly parse LNBP team names, scores, and player statistics', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>FUERZA REGIA</span>
					<div class="score">85 vs 82</div>
					<span>ASTROS DE JALISCO</span>
				</div>

				<div class="stats-section">
					<h2>FUERZA REGIA</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Julián Quiñones</td>
								<td>28:15</td>
								<td>5</td>
								<td>10</td>
								<td>2</td>
								<td>5</td>
								<td>2</td>
								<td>2</td>
								<td>1</td>
								<td>4</td>
								<td>5</td>
								<td>6</td>
								<td>2</td>
								<td>1</td>
								<td>2</td>
								<td>3</td>
								<td>14</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>30</td>
								<td>60</td>
								<td>10</td>
								<td>25</td>
								<td>15</td>
								<td>18</td>
								<td>8</td>
								<td>22</td>
								<td>30</td>
								<td>18</td>
								<td>8</td>
								<td>3</td>
								<td>12</td>
								<td>20</td>
								<td>85</td>
							</tr>
						</tbody>
					</table>

					<h2>ASTROS DE JALISCO</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Rigoberto Mendoza</td>
								<td>25:12</td>
								<td>4</td>
								<td>8</td>
								<td>1</td>
								<td>3</td>
								<td>3</td>
								<td>4</td>
								<td>2</td>
								<td>3</td>
								<td>5</td>
								<td>2</td>
								<td>1</td>
								<td>0</td>
								<td>1</td>
								<td>2</td>
								<td>12</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>28</td>
								<td>58</td>
								<td>9</td>
								<td>22</td>
								<td>17</td>
								<td>20</td>
								<td>7</td>
								<td>20</td>
								<td>27</td>
								<td>15</td>
								<td>6</td>
								<td>2</td>
								<td>14</td>
								<td>22</td>
								<td>82</td>
							</tr>
						</tbody>
					</table>
				</div>
			</body>
			</html>
		`;

		const boxscore = parseLnbpHtml(sampleHtml, 'fuerza-regia', 'astros-de-jalisco', 'fuerza-regia-vs-astros-de-jalisco-M2099_890123', '2099');

		assert.equal(boxscore.homeTeam.teamName, 'FUERZA REGIA');
		assert.equal(boxscore.awayTeam.teamName, 'ASTROS DE JALISCO');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.equal(boxscore.awayTeam.score, 82);

		const quinones = boxscore.homeTeam.players.find(p => p.playerName === 'Julián Quiñones');
		assert.ok(quinones, 'Should parse Quiñones successfully');
		assert.equal(quinones.statistics.pts, 14);
		assert.equal(quinones.statistics.min, '28:15');

		const mendoza = boxscore.awayTeam.players.find(p => p.playerName === 'Rigoberto Mendoza');
		assert.ok(mendoza, 'Should parse Mendoza successfully');
		assert.equal(mendoza.statistics.pts, 12);
		assert.equal(mendoza.statistics.min, '25:12');
	});

	test('Full Mexico Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new LnbpScraper();

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('M2099_890123'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const quinones = transformed.players.find(p => p.player_id === 'julian-quinones');
			assert.ok(quinones);
			assert.equal(quinones.team_id, 'fuerza-regia'); // resolved team ID from config/mexico_team_mappings.json
			assert.equal(quinones.pts, 14);
			assert.equal(quinones.min, '28.3'); // "28:15" parses to 28.3 minutes (rounded to 1 decimal place)

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('mexico', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Julián Quiñones'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('mexico', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'FUERZA REGIA'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
