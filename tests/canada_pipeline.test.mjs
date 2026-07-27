import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CeblScraper } from '../src/scrapers/canada/CeblScraper.mjs';
import { CeblHarvester } from '../src/scrapers/canada/harvesters/CeblHarvester.mjs';
import { parseCeblHtml } from '../src/scrapers/canada/parsers/CeblParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Canada CEBL Scraper & Pipeline Integration', () => {
	const league = 'canada_test';
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

	test('CeblHarvester should return mock slugs in test mode', async () => {
		const harvester = new CeblHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2099');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-2099-'), 'Slugs must contain year segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^\d+$/, 'gameId Segment must match CEBL numeric pattern');
	});

	test('CeblScraper should return correct unified schema mock data', async () => {
		const scraper = new CeblScraper();
		const boxscore = await scraper.request('cebl-2099-10492');

		assert.equal(boxscore.gameId, 'cebl-2099-10492');
		assert.equal(boxscore.season, '2099');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'VANCOUVER BANDITS');
		assert.equal(boxscore.homeTeam.score, 95);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const nickWard = boxscore.homeTeam.players.find(p => p.playerName.includes('Nick Ward'));
		assert.ok(nickWard);
		assert.equal(nickWard.playerId, 'nick-ward');
		assert.equal(nickWard.statistics.pts, 22);
		assert.equal(nickWard.statistics.min, '24:30');
	});

	test('CeblScraper HTML Parser should correctly parse CEBL team names, scores, and player statistics from raw HTML', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div>
					<h1>VANCOUVER BANDITS</h1>
					<table class="stats-table">
						<thead>
							<tr>
								<th>Player</th>
								<th>Min</th>
								<th>Pts</th>
								<th>FGM</th>
								<th>FGA</th>
								<th>3PM</th>
								<th>3PA</th>
								<th>FTM</th>
								<th>FTA</th>
								<th>OR</th>
								<th>DR</th>
								<th>REB</th>
								<th>AST</th>
								<th>STL</th>
								<th>BLK</th>
								<th>TO</th>
								<th>PF</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td class="player-name">12 Nick Ward</td>
								<td class="col-min">24:30</td>
								<td class="col-pts">22</td>
								<td class="col-fgm">8</td>
								<td class="col-fga">12</td>
								<td class="col-fg3m">0</td>
								<td class="col-fg3a">0</td>
								<td class="col-ftm">6</td>
								<td class="col-fta">8</td>
								<td class="col-oreb">3</td>
								<td class="col-dreb">5</td>
								<td class="col-reb">8</td>
								<td class="col-ast">2</td>
								<td class="col-stl">1</td>
								<td class="col-blk">2</td>
								<td class="col-to">3</td>
								<td class="col-pf">4</td>
							</tr>
							<tr class="totals">
								<td class="player-name">Total</td>
								<td class="col-min">200:00</td>
								<td class="col-pts">95</td>
								<td class="col-fgm">35</td>
								<td class="col-fga">70</td>
								<td class="col-fg3m">5</td>
								<td class="col-fg3a">15</td>
								<td class="col-ftm">20</td>
								<td class="col-fta">25</td>
								<td class="col-oreb">10</td>
								<td class="col-dreb">25</td>
								<td class="col-reb">35</td>
								<td class="col-ast">15</td>
								<td class="col-stl">8</td>
								<td class="col-blk">5</td>
								<td class="col-to">12</td>
								<td class="col-pf">18</td>
							</tr>
						</tbody>
					</table>
				</div>

				<div>
					<h1>NIAGARA RIVER LIONS</h1>
					<table class="boxscore-table">
						<thead>
							<tr>
								<th>Player</th>
								<th>Min</th>
								<th>Pts</th>
								<th>FGM</th>
								<th>FGA</th>
								<th>3PM</th>
								<th>3PA</th>
								<th>FTM</th>
								<th>FTA</th>
								<th>OR</th>
								<th>DR</th>
								<th>REB</th>
								<th>AST</th>
								<th>STL</th>
								<th>BLK</th>
								<th>TO</th>
								<th>PF</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td class="player-name">Jahvon Blair</td>
								<td class="col-min">28:15</td>
								<td class="col-pts">18</td>
								<td class="col-fgm">6</td>
								<td class="col-fga">14</td>
								<td class="col-fg3m">3</td>
								<td class="col-fg3a">7</td>
								<td class="col-ftm">3</td>
								<td class="col-fta">4</td>
								<td class="col-oreb">1</td>
								<td class="col-dreb">4</td>
								<td class="col-reb">5</td>
								<td class="col-ast">4</td>
								<td class="col-stl">2</td>
								<td class="col-blk">0</td>
								<td class="col-to">2</td>
								<td class="col-pf">3</td>
							</tr>
							<tr class="totals">
								<td class="player-name">Total</td>
								<td class="col-min">200:00</td>
								<td class="col-pts">90</td>
								<td class="col-fgm">32</td>
								<td class="col-fga">68</td>
								<td class="col-fg3m">8</td>
								<td class="col-fg3a">20</td>
								<td class="col-ftm">18</td>
								<td class="col-fta">22</td>
								<td class="col-oreb">8</td>
								<td class="col-dreb">22</td>
								<td class="col-reb">30</td>
								<td class="col-ast">12</td>
								<td class="col-stl">6</td>
								<td class="col-blk">2</td>
								<td class="col-to">14</td>
								<td class="col-pf">20</td>
							</tr>
						</tbody>
					</table>
				</div>
			</body>
			</html>
		`;

		const boxscore = parseCeblHtml(sampleHtml, 'cebl-2099-10492', '2099');

		assert.equal(boxscore.homeTeam.teamName, 'VANCOUVER BANDITS');
		assert.equal(boxscore.awayTeam.teamName, 'NIAGARA RIVER LIONS');
		assert.equal(boxscore.homeTeam.score, 95);
		assert.equal(boxscore.awayTeam.score, 90);

		const ward = boxscore.homeTeam.players.find(p => p.playerName === 'Nick Ward');
		assert.ok(ward, 'Should parse Nick Ward successfully');
		assert.equal(ward.statistics.pts, 22);
		assert.equal(ward.statistics.min, '24:30');
		assert.equal(ward.statistics.fgm, 8);
		assert.equal(ward.statistics.fga, 12);

		const blair = boxscore.awayTeam.players.find(p => p.playerName === 'Jahvon Blair');
		assert.ok(blair, 'Should parse Jahvon Blair successfully');
		assert.equal(blair.statistics.pts, 18);
		assert.equal(blair.statistics.min, '28:15');
		assert.equal(blair.statistics.fgm, 6);
		assert.equal(blair.statistics.fga, 14);
	});

	test('Full Canada Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new CeblScraper();

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('10492'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const ward = transformed.players.find(p => p.player_id === 'nick-ward');
			assert.ok(ward);
			assert.equal(ward.team_id, 'vancouver-bandits'); // resolved team ID from config/canada_team_mappings.json
			assert.equal(ward.pts, 22);
			assert.equal(ward.min, '24.5'); // "24:30" parses to 24.5 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('canada', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Nick Ward'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('canada', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'VANCOUVER BANDITS'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
