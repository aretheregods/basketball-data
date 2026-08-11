process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { AsiaScraper } from '../src/scrapers/asia/AsiaScraper.mjs';
import { AsiaHarvester } from '../src/scrapers/asia/harvesters/AsiaHarvester.mjs';
import { parseAsiaHtml } from '../src/scrapers/asia/parsers/AsiaParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Asia Multi-Competition Scraper & Pipeline Integration', () => {
	const league = 'asia_test';
	const year = '2024'; // Unique test year to isolate test runs

	test.before(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('AsiaHarvester should return mock slugs for active competitions in test mode', async () => {
		// Test with EASL, WASL, and B.League
		const scraper = new AsiaScraper({ competitions: 'easl,wasl,bleague' });
		const harvester = scraper.harvester;
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');

		// Should have EASL slugs
		const easlSlug = slugs.find(s => s.includes('-EASL2024_'));
		assert.ok(easlSlug, 'Must contain EASL segment');
		const easlGameId = easlSlug.split('-').pop();
		assert.match(easlGameId, /^EASL2024_\d+$/, 'gameId Segment must match EASL pattern');

		// Should have B.League slugs
		const bleagueSlug = slugs.find(s => s.includes('-BLEAGUE2024_'));
		assert.ok(bleagueSlug, 'Must contain BLEAGUE segment');
		const bleagueGameId = bleagueSlug.split('-').pop();
		assert.match(bleagueGameId, /^BLEAGUE2024_\d+$/, 'gameId Segment must match BLEAGUE pattern');

		// Should have WASL slugs
		const waslSlug = slugs.find(s => s.includes('-WASL2024_'));
		assert.ok(waslSlug, 'Must contain WASL segment');
		const waslGameId = waslSlug.split('-').pop();
		assert.match(waslGameId, /^WASL2024_\d+$/, 'gameId Segment must match WASL pattern');
	});

	test('AsiaScraper should return correct unified schema mock data for different competitions', async () => {
		const scraper = new AsiaScraper({ competitions: 'easl,wasl,bleague' });

		// EASL check
		const easlBox = await scraper.request('ryukyu-golden-kings-vs-seoul-sk-knights-EASL2024_10001');
		assert.equal(easlBox.gameId, 'ryukyu-golden-kings-vs-seoul-sk-knights-EASL2024_10001');
		assert.equal(easlBox.homeTeam.teamName, 'RYUKYU GOLDEN KINGS');
		assert.equal(easlBox.homeTeam.score, 88);

		// B.League check
		const bleagueBox = await scraper.request('ryukyu-golden-kings-vs-chiba-jets-BLEAGUE2024_20001');
		assert.equal(bleagueBox.gameId, 'ryukyu-golden-kings-vs-chiba-jets-BLEAGUE2024_20001');
		assert.equal(bleagueBox.homeTeam.teamName, 'RYUKYU GOLDEN KINGS');
		assert.equal(bleagueBox.homeTeam.score, 85);
		assert.equal(bleagueBox.awayTeam.teamName, 'CHIBA JETS');
		assert.equal(bleagueBox.awayTeam.score, 79);

		// WASL check
		const waslBox = await scraper.request('al-riyadi-vs-shahrdari-gorgan-WASL2024_30001');
		assert.equal(waslBox.gameId, 'al-riyadi-vs-shahrdari-gorgan-WASL2024_30001');
		assert.equal(waslBox.homeTeam.teamName, 'AL RIYADI');
		assert.equal(waslBox.homeTeam.score, 96);
		assert.equal(waslBox.awayTeam.teamName, 'SHAHRDARI GORGAN');
		assert.equal(waslBox.awayTeam.score, 84);
	});

	test('AsiaScraper HTML Parser should correctly parse Asia team names, scores, and player statistics from Proballers HTML', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>RYUKYU GOLDEN KINGS</span>
					<div class="score">88 vs 82</div>
					<span>SEOUL SK KNIGHTS</span>
				</div>

				<div class="stats-section">
					<h2>RYUKYU GOLDEN KINGS</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Jack Cooley</td>
								<td>28:30</td>
								<td>7</td>
								<td>11</td>
								<td>0</td>
								<td>0</td>
								<td>4</td>
								<td>6</td>
								<td>5</td>
								<td>8</td>
								<td>13</td>
								<td>2</td>
								<td>1</td>
								<td>1</td>
								<td>2</td>
								<td>3</td>
								<td>18</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>32</td>
								<td>62</td>
								<td>4</td>
								<td>12</td>
								<td>20</td>
								<td>30</td>
								<td>15</td>
								<td>25</td>
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

					<h2>SEOUL SK KNIGHTS</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Jameel Warney</td>
								<td>32:15</td>
								<td>8</td>
								<td>16</td>
								<td>0</td>
								<td>1</td>
								<td>5</td>
								<td>7</td>
								<td>3</td>
								<td>7</td>
								<td>10</td>
								<td>3</td>
								<td>2</td>
								<td>1</td>
								<td>3</td>
								<td>3</td>
								<td>21</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>30</td>
								<td>64</td>
								<td>2</td>
								<td>14</td>
								<td>20</td>
								<td>28</td>
								<td>10</td>
								<td>26</td>
								<td>36</td>
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

		const boxscore = parseAsiaHtml(sampleHtml, 'ryukyu', 'seoul', 'ryukyu-golden-kings-vs-seoul-sk-knights-EASL2024_10001', '2024');

		assert.equal(boxscore.homeTeam.teamName, 'RYUKYU GOLDEN KINGS');
		assert.equal(boxscore.awayTeam.teamName, 'SEOUL SK KNIGHTS');
		assert.equal(boxscore.homeTeam.score, 88);
		assert.equal(boxscore.awayTeam.score, 82);

		const cooley = boxscore.homeTeam.players.find(p => p.playerName === 'Jack Cooley');
		assert.ok(cooley, 'Should parse Jack Cooley successfully');
		assert.equal(cooley.statistics.pts, 18);
		assert.equal(cooley.statistics.min, '28:30');

		const warney = boxscore.awayTeam.players.find(p => p.playerName === 'Jameel Warney');
		assert.ok(warney, 'Should parse Jameel Warney successfully');
		assert.equal(warney.statistics.pts, 21);
		assert.equal(warney.statistics.min, '32:15');
	});

	test('Full Asia Multi-Competition Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new AsiaScraper({ competitions: 'easl,bleague,wasl' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('EASL2024_10001'));
			assert.ok(gameIds.includes('BLEAGUE2024_20001'));
			assert.ok(gameIds.includes('WASL2024_30001'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed EASL records
			const cooleyEasl = transformed.players.find(p => p.game_id === 'EASL2024_10001' && p.player_id === 'jack-cooley');
			assert.ok(cooleyEasl);
			assert.equal(cooleyEasl.team_id, 'asia-ryukyu'); // resolved team ID from config/asia_team_mappings.json
			assert.equal(cooleyEasl.pts, 18);
			assert.equal(cooleyEasl.min, '28.5'); // "28:30" parses to 28.5 minutes

			const warneyEasl = transformed.players.find(p => p.game_id === 'EASL2024_10001' && p.player_id === 'jameel-warney');
			assert.ok(warneyEasl);
			assert.equal(warneyEasl.team_id, 'asia-seoul-sk'); // resolved team ID
			assert.equal(warneyEasl.pts, 21);
			assert.equal(warneyEasl.min, '32.3'); // "32:15" parses to 32.3 minutes

			// Assert transformed B.League records
			const cooleyBleague = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20001' && p.player_id === 'jack-cooley');
			assert.ok(cooleyBleague);
			assert.equal(cooleyBleague.team_id, 'asia-ryukyu');
			assert.equal(cooleyBleague.pts, 18);
			assert.equal(cooleyBleague.min, '28.5');

			const togashiBleague = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20001' && p.player_id === 'yuki-togashi');
			assert.ok(togashiBleague);
			assert.equal(togashiBleague.team_id, 'chiba-jets');
			assert.equal(togashiBleague.pts, 22);
			assert.equal(togashiBleague.min, '32.3');

			// Assert transformed WASL records
			const arakjiWasl = transformed.players.find(p => p.game_id === 'WASL2024_30001' && p.player_id === 'wael-arakji');
			assert.ok(arakjiWasl);
			assert.equal(arakjiWasl.team_id, 'asia-riyadi'); // resolved team ID
			assert.equal(arakjiWasl.pts, 24);
			assert.equal(arakjiWasl.min, '30.3');

			const cherryWasl = transformed.players.find(p => p.game_id === 'WASL2024_30001' && p.player_id === 'will-cherry');
			assert.ok(cherryWasl);
			assert.equal(cherryWasl.team_id, 'shahrdari-gorgan'); // resolved team ID
			assert.equal(cherryWasl.pts, 16);
			assert.equal(cherryWasl.min, '29.8');

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('asia', year);
				assert.ok(playerStats.length > 0);

				// Verify both games exist under 'asia' league roll-up
				assert.ok(playerStats.some(p => p.player_name === 'Jack Cooley' && p.game_id.includes('EASL')));
				assert.ok(playerStats.some(p => p.player_name === 'Jack Cooley' && p.game_id.includes('BLEAGUE')));
				assert.ok(playerStats.some(p => p.player_name === 'Wael Arakji' && p.game_id.includes('WASL')));
				assert.ok(playerStats.some(p => p.player_name === 'Will Cherry'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('asia', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'RYUKYU GOLDEN KINGS' && t.game_id.includes('EASL')));
				assert.ok(teamStats.some(t => t.team_name === 'AL RIYADI' && t.game_id.includes('WASL')));
				assert.ok(teamStats.some(t => t.team_name === 'SHAHRDARI GORGAN'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
