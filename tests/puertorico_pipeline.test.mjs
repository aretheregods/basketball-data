process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BsnScraper } from '../src/scrapers/puertorico/BsnScraper.mjs';
import { BsnHarvester } from '../src/scrapers/puertorico/harvesters/BsnHarvester.mjs';
import { parseBsnHtml } from '../src/scrapers/puertorico/parsers/BsnParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Puerto Rico BSN Scraper & Pipeline Integration', () => {
	const league = 'puertorico_test';
	const year = '2099'; // Unique test year to isolate test runs

	test.before(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('BsnHarvester should return mock slugs in test mode', async () => {
		const harvester = new BsnHarvester();
		harvester.scraper = { bypassNetwork: true };
		const slugs = await harvester.getSeasonGameSlugs('2099');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-B2099_'), 'Slugs must contain Bsegment segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^B2099_\d+$/, 'gameId Segment must match BSN pattern');
	});

	test('BsnScraper should return correct unified schema mock data', async () => {
		const scraper = new BsnScraper();
		const boxscore = await scraper.request('vaqueros-de-bayamon-vs-capitanes-de-arecibo-B2099_2111481');

		assert.equal(boxscore.gameId, 'vaqueros-de-bayamon-vs-capitanes-de-arecibo-B2099_2111481');
		assert.equal(boxscore.season, '2099');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'VAQUEROS DE BAYAMON');
		assert.equal(boxscore.homeTeam.score, 95);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const tremontWaters = boxscore.homeTeam.players.find(p => p.playerName.includes('Tremont Waters'));
		assert.ok(tremontWaters);
		assert.equal(tremontWaters.playerId, 'tremont-waters');
		assert.equal(tremontWaters.statistics.pts, 22);
		assert.equal(tremontWaters.statistics.min, '24:30');
	});

	test('BsnScraper HTML Parser should correctly parse BSN team names, scores, and player statistics from Proballers HTML', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>VAQUEROS DE BAYAMON</span>
					<div class="score">95 vs 90</div>
					<span>CAPITANES DE ARECIBO</span>
				</div>

				<div class="stats-section">
					<h2>VAQUEROS DE BAYAMON</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Tremont Waters</td>
								<td>24:30</td>
								<td>8</td>
								<td>12</td>
								<td>2</td>
								<td>4</td>
								<td>4</td>
								<td>4</td>
								<td>1</td>
								<td>4</td>
								<td>5</td>
								<td>6</td>
								<td>2</td>
								<td>0</td>
								<td>2</td>
								<td>3</td>
								<td>22</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>35</td>
								<td>65</td>
								<td>8</td>
								<td>20</td>
								<td>17</td>
								<td>22</td>
								<td>8</td>
								<td>24</td>
								<td>32</td>
								<td>18</td>
								<td>8</td>
								<td>2</td>
								<td>12</td>
								<td>20</td>
								<td>95</td>
							</tr>
						</tbody>
					</table>

					<h2>CAPITANES DE ARECIBO</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Ángel Rodríguez</td>
								<td>28:15</td>
								<td>6</td>
								<td>14</td>
								<td>3</td>
								<td>7</td>
								<td>3</td>
								<td>4</td>
								<td>1</td>
								<td>4</td>
								<td>5</td>
								<td>4</td>
								<td>2</td>
								<td>0</td>
								<td>2</td>
								<td>3</td>
								<td>18</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>32</td>
								<td>60</td>
								<td>10</td>
								<td>25</td>
								<td>16</td>
								<td>20</td>
								<td>7</td>
								<td>22</td>
								<td>29</td>
								<td>15</td>
								<td>6</td>
								<td>1</td>
								<td>14</td>
								<td>22</td>
								<td>90</td>
							</tr>
						</tbody>
					</table>
				</div>
			</body>
			</html>
		`;

		const boxscore = parseBsnHtml(sampleHtml, 'vaqueros-de-bayamon', 'capitanes-de-arecibo', 'vaqueros-de-bayamon-vs-capitanes-de-arecibo-B2099_2111481', '2099');

		assert.equal(boxscore.homeTeam.teamName, 'VAQUEROS DE BAYAMON');
		assert.equal(boxscore.awayTeam.teamName, 'CAPITANES DE ARECIBO');
		assert.equal(boxscore.homeTeam.score, 95);
		assert.equal(boxscore.awayTeam.score, 90);

		const waters = boxscore.homeTeam.players.find(p => p.playerName === 'Tremont Waters');
		assert.ok(waters, 'Should parse Tremont Waters successfully');
		assert.equal(waters.statistics.pts, 22);
		assert.equal(waters.statistics.min, '24:30');

		const rodriguez = boxscore.awayTeam.players.find(p => p.playerName === 'Ángel Rodríguez');
		assert.ok(rodriguez, 'Should parse Ángel Rodríguez successfully');
		assert.equal(rodriguez.statistics.pts, 18);
		assert.equal(rodriguez.statistics.min, '28:15');
	});

	test('Full Puerto Rico Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new BsnScraper();

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('B2099_2111481'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const waters = transformed.players.find(p => p.player_id === 'tremont-waters');
			assert.ok(waters);
			assert.equal(waters.team_id, 'vaqueros-bayamon'); // resolved team ID from config/puertorico_team_mappings.json
			assert.equal(waters.pts, 22);
			assert.equal(waters.min, '24.5'); // "24:30" parses to 24.5 minutes

			const rodriguez = transformed.players.find(p => p.player_id === 'angel-rodriguez');
			assert.ok(rodriguez);
			assert.equal(rodriguez.team_id, 'capitanes-arecibo'); // resolved team ID
			assert.equal(rodriguez.pts, 18);
			assert.equal(rodriguez.min, '28.3'); // "28:15" parses to 28.3 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('puertorico', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Tremont Waters'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('puertorico', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'VAQUEROS DE BAYAMON'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
