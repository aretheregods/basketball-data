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

test.describe('Asia Basketball Pipeline & Scraper Integration', () => {
	const league = 'asia_test';
	const year = '2024'; // Isolated year for pipeline test

	test.before(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('AsiaHarvester should auto-route bcl_asia queries prior to 2024 to FIBA Asia Champions Cup and vice versa', async () => {
		const scraper = new AsiaScraper({ competitions: 'bcl_asia' });
		scraper.bypassNetwork = true;
		const harvester = scraper.harvester;

		// 1. Auto-routing pre-2024 bcl_asia to fiba_asia_cc
		const route2019Bcl = harvester.resolveTargetCompetition('bcl_asia', '2019');
		assert.equal(route2019Bcl.resolvedComp, 'fiba_asia_cc');
		assert.equal(route2019Bcl.isCancelled, false);
		assert.match(route2019Bcl.mappedNotice, /Auto-routed bcl_asia for year 2019 to predecessor tournament FIBA Asia Champions Cup/);

		// Harvesting slugs for 2019 bcl_asia should now return FIBA Asia CC games instead of 0 games
		const slugs2019 = await harvester.getSeasonGameSlugs('2019');
		assert.ok(slugs2019.length > 0, '2019 bcl_asia query should auto-route and return games');
		assert.ok(slugs2019.some(s => s.includes('FIBAASIACC2019_')));

		// 2. Auto-routing post-2023 fiba_asia_cc to bcl_asia
		const route2024Fiba = harvester.resolveTargetCompetition('fiba_asia_cc', '2024');
		assert.equal(route2024Fiba.resolvedComp, 'bcl_asia');
		assert.equal(route2024Fiba.isCancelled, false);

		// 3. Pandemic years (2020-2023) should remain cancelled
		const route2021Bcl = harvester.resolveTargetCompetition('bcl_asia', '2021');
		assert.equal(route2021Bcl.isCancelled, true);
		assert.match(route2021Bcl.reason, /not held between 2020 and 2023/);

		// 4. Valid 2024 BCL Asia should pass cleanly
		const route2024Bcl = harvester.resolveTargetCompetition('bcl_asia', '2024');
		assert.equal(route2024Bcl.resolvedComp, 'bcl_asia');
		assert.equal(route2024Bcl.isCancelled, false);
	});

	test('AsiaHarvester should return mock slugs for active competitions in test mode', async () => {
		const scraper = new AsiaScraper({ competitions: 'bcl_asia,bleague,kbl' });
		scraper.bypassNetwork = true;
		const harvester = scraper.harvester;
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return slugs');

		// Check BCL Asia Segment
		const bclSlug = slugs.find(s => s.includes('-BCLASIA2024_'));
		assert.ok(bclSlug);
		const bclGameId = bclSlug.split('-').pop();
		assert.match(bclGameId, /^BCLASIA2024_\d+$/);

		// Check B.League Segment
		const bleagueSlug = slugs.find(s => s.includes('-BLEAGUE2024_'));
		assert.ok(bleagueSlug);
		const bleagueGameId = bleagueSlug.split('-').pop();
		assert.match(bleagueGameId, /^BLEAGUE2024_\d+$/);

		// Check KBL Segment
		const kblSlug = slugs.find(s => s.includes('-KBL2024_'));
		assert.ok(kblSlug);
		const kblGameId = kblSlug.split('-').pop();
		assert.match(kblGameId, /^KBL2024_\d+$/);
	});

	test('AsiaScraper should return correct unified schema mock data based on competition', async () => {
		const scraper = new AsiaScraper({ competitions: 'bcl_asia,bleague,kbl,fiba_asia_cc' });
		scraper.bypassNetwork = true;

		// bleague check
		const bleagueBox = await scraper.request('ryukyu-golden-kings-vs-chiba-jets-BLEAGUE2024_20001');
		assert.equal(bleagueBox.gameId, 'ryukyu-golden-kings-vs-chiba-jets-BLEAGUE2024_20001');
		assert.equal(bleagueBox.homeTeam.teamName, 'RYUKYU GOLDEN KINGS');
		assert.equal(bleagueBox.homeTeam.score, 87);
		assert.equal(bleagueBox.awayTeam.teamName, 'CHIBA JETS');
		assert.equal(bleagueBox.awayTeam.score, 82);

		// kbl check
		const kblBox = await scraper.request('seoul-sk-knights-vs-db-promy-KBL2024_30001');
		assert.equal(kblBox.gameId, 'seoul-sk-knights-vs-db-promy-KBL2024_30001');
		assert.equal(kblBox.homeTeam.teamName, 'SEOUL SK KNIGHTS');
		assert.equal(kblBox.homeTeam.score, 91);
		assert.equal(kblBox.awayTeam.teamName, 'DB PROMY');
		assert.equal(kblBox.awayTeam.score, 83);

		// fiba_asia_cc check
		const fibaBox = await scraper.request('al-riyadi-vs-alvark-tokyo-FIBAASIACC2019_40001');
		assert.equal(fibaBox.gameId, 'al-riyadi-vs-alvark-tokyo-FIBAASIACC2019_40001');
		assert.equal(fibaBox.homeTeam.teamName, 'AL RIYADI');
		assert.equal(fibaBox.homeTeam.score, 95);
		assert.equal(fibaBox.awayTeam.teamName, 'ALVARK TOKYO');
		assert.equal(fibaBox.awayTeam.score, 83);
	});

	test('AsiaParser HTML regex table parser should correctly parse dynamic columns and player statistics', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>RYUKYU GOLDEN KINGS</span>
					<div class="score">87 vs 82</div>
					<span>CHIBA JETS</span>
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
								<td>8</td>
								<td>12</td>
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
								<td>1</td>
								<td>3</td>
								<td>20</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>32</td>
								<td>60</td>
								<td>4</td>
								<td>12</td>
								<td>19</td>
								<td>26</td>
								<td>14</td>
								<td>26</td>
								<td>40</td>
								<td>14</td>
								<td>5</td>
								<td>3</td>
								<td>12</td>
								<td>16</td>
								<td>87</td>
							</tr>
						</tbody>
					</table>

					<h2>CHIBA JETS</h2>
					<table>
						<thead>
							<tr><th>Player</th><th>Min</th><th>FGM</th><th>FGA</th><th>3PM</th><th>3PA</th><th>FTM</th><th>FTA</th><th>OR</th><th>DR</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>PTS</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>Yuki Togashi</td>
								<td>32:15</td>
								<td>7</td>
								<td>15</td>
								<td>4</td>
								<td>9</td>
								<td>4</td>
								<td>4</td>
								<td>0</td>
								<td>2</td>
								<td>2</td>
								<td>8</td>
								<td>2</td>
								<td>0</td>
								<td>3</td>
								<td>2</td>
								<td>22</td>
							</tr>
							<tr class="total">
								<td>Total</td>
								<td>200:00</td>
								<td>30</td>
								<td>65</td>
								<td>8</td>
								<td>22</td>
								<td>14</td>
								<td>16</td>
								<td>6</td>
								<td>20</td>
								<td>26</td>
								<td>18</td>
								<td>8</td>
								<td>1</td>
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

		const boxscore = parseAsiaHtml(sampleHtml, 'ryukyu-golden-kings', 'chiba-jets', 'ryukyu-golden-kings-vs-chiba-jets-BLEAGUE2024_20001', '2024');

		assert.equal(boxscore.homeTeam.teamName, 'RYUKYU GOLDEN KINGS');
		assert.equal(boxscore.awayTeam.teamName, 'CHIBA JETS');
		assert.equal(boxscore.homeTeam.score, 87);
		assert.equal(boxscore.awayTeam.score, 82);

		const cooley = boxscore.homeTeam.players.find(p => p.playerName === 'Jack Cooley');
		assert.ok(cooley);
		assert.equal(cooley.statistics.pts, 20);
		assert.equal(cooley.statistics.min, '28:30');

		const togashi = boxscore.awayTeam.players.find(p => p.playerName === 'Yuki Togashi');
		assert.ok(togashi);
		assert.equal(togashi.statistics.pts, 22);
		assert.equal(togashi.statistics.min, '32:15');
	});

	test('Full Asia Multi-Competition Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new AsiaScraper({ competitions: 'bcl_asia,bleague,kbl,fiba_asia_cc' });
			scraper.bypassNetwork = true;

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('BCLASIA2024_10001'));
			assert.ok(gameIds.includes('BLEAGUE2024_20001'));
			assert.ok(gameIds.includes('KBL2024_30001'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed BLEAGUE records
			const cooleyBleague = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20001' && p.player_id === 'jack-cooley');
			assert.ok(cooleyBleague);
			assert.equal(cooleyBleague.team_id, 'ryukyu-golden-kings'); // mapped from config/asia_team_mappings.json
			assert.equal(cooleyBleague.pts, 20);
			assert.equal(cooleyBleague.min, '28.5'); // "28:30" -> 28.5 minutes

			const togashiBleague = transformed.players.find(p => p.game_id === 'BLEAGUE2024_20001' && p.player_id === 'yuki-togashi');
			assert.ok(togashiBleague);
			assert.equal(togashiBleague.team_id, 'chiba-jets'); // mapped
			assert.equal(togashiBleague.pts, 22);
			assert.equal(togashiBleague.min, '32.3'); // "32:15" -> 32.3 minutes

			// Assert transformed KBL records
			const warneyKbl = transformed.players.find(p => p.game_id === 'KBL2024_30001' && p.player_id === 'jameel-warney');
			assert.ok(warneyKbl);
			assert.equal(warneyKbl.team_id, 'seoul-sk-knights'); // mapped
			assert.equal(warneyKbl.pts, 26);
			assert.equal(warneyKbl.min, '34.5'); // "34:30" -> 34.5 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Local Staging Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('asia', year);
				assert.ok(playerStats.length > 0);

				// Verify games exist under 'asia' league rollup
				assert.ok(playerStats.some(p => p.player_name === 'Jack Cooley' && p.game_id.includes('BLEAGUE')));
				assert.ok(playerStats.some(p => p.player_name === 'Jameel Warney' && p.game_id.includes('KBL')));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('asia', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'RYUKYU GOLDEN KINGS' && t.game_id.includes('BLEAGUE')));
				assert.ok(teamStats.some(t => t.team_name === 'SEOUL SK KNIGHTS' && t.game_id.includes('KBL')));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUG SUBTEST 5 ERROR:', err);
			throw err;
		}
	});
});
