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

test.describe('South America Multi-Competition Scraper & Pipeline Integration', () => {
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

	test('SouthAmericaHarvester should return mock slugs for active competitions in test mode', async () => {
		// Test with BCLA, NBB, and SPB (Venezuela)
		const scraper = new SouthAmericaScraper({ competitions: 'bcla,nbb,spb' });
		const harvester = scraper.harvester;
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');

		// Should have BCLA slugs
		const bclaSlug = slugs.find(s => s.includes('-BCLA2024_'));
		assert.ok(bclaSlug, 'Must contain BCLA segment');
		const bclaGameId = bclaSlug.split('-').pop();
		assert.match(bclaGameId, /^BCLA2024_\d+$/, 'gameId Segment must match BCLA pattern');

		// Should have NBB slugs
		const nbbSlug = slugs.find(s => s.includes('-NBB2024_'));
		assert.ok(nbbSlug, 'Must contain NBB segment');
		const nbbGameId = nbbSlug.split('-').pop();
		assert.match(nbbGameId, /^NBB2024_\d+$/, 'gameId Segment must match NBB pattern');

		// Should have SPB slugs
		const spbSlug = slugs.find(s => s.includes('-SPB2024_'));
		assert.ok(spbSlug, 'Must contain SPB segment');
		const spbGameId = spbSlug.split('-').pop();
		assert.match(spbGameId, /^SPB2024_\d+$/, 'gameId Segment must match SPB pattern');
	});

	test('SouthAmericaScraper should return correct unified schema mock data for different competitions', async () => {
		const scraper = new SouthAmericaScraper({ competitions: 'bcla,nbb,spb' });

		// BCLA check
		const bclaBox = await scraper.request('flamengo-vs-quimsa-BCLA2024_10001');
		assert.equal(bclaBox.gameId, 'flamengo-vs-quimsa-BCLA2024_10001');
		assert.equal(bclaBox.homeTeam.teamName, 'FLAMENGO');
		assert.equal(bclaBox.homeTeam.score, 88);

		// NBB check
		const nbbBox = await scraper.request('flamengo-vs-franca-NBB2024_20001');
		assert.equal(nbbBox.gameId, 'flamengo-vs-franca-NBB2024_20001');
		assert.equal(nbbBox.homeTeam.teamName, 'FLAMENGO');
		assert.equal(nbbBox.homeTeam.score, 92);
		assert.equal(nbbBox.awayTeam.teamName, 'FRANCA');
		assert.equal(nbbBox.awayTeam.score, 84);

		// SPB check
		const spbBox = await scraper.request('gladiadores-de-anzoategui-vs-trotamundos-de-carabobo-SPB2024_30001');
		assert.equal(spbBox.gameId, 'gladiadores-de-anzoategui-vs-trotamundos-de-carabobo-SPB2024_30001');
		assert.equal(spbBox.homeTeam.teamName, 'GLADIADORES DE ANZOATEGUI');
		assert.equal(spbBox.homeTeam.score, 94);
		assert.equal(spbBox.awayTeam.teamName, 'TROTAMUNDOS DE CARABOBO');
		assert.equal(spbBox.awayTeam.score, 84);
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

		const boxscore = parseSouthAmericaHtml(sampleHtml, 'flamengo', 'quimsa', 'flamengo-vs-quimsa-BCLA2024_10001', '2024');

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

	test('Full South America Multi-Competition Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new SouthAmericaScraper({ competitions: 'bcla,nbb,spb' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('BCLA2024_10001'));
			assert.ok(gameIds.includes('NBB2024_20001'));
			assert.ok(gameIds.includes('SPB2024_30001'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed BCLA records
			const galvaniniBcla = transformed.players.find(p => p.game_id === 'BCLA2024_10001' && p.player_id === 'gabriel-galvanini');
			assert.ok(galvaniniBcla);
			assert.equal(galvaniniBcla.team_id, 'flamengo'); // resolved team ID from config/southamerica_team_mappings.json
			assert.equal(galvaniniBcla.pts, 18);
			assert.equal(galvaniniBcla.min, '28.5'); // "28:30" parses to 28.5 minutes

			const robinsonBcla = transformed.players.find(p => p.game_id === 'BCLA2024_10001' && p.player_id === 'brandon-robinson');
			assert.ok(robinsonBcla);
			assert.equal(robinsonBcla.team_id, 'quimsa'); // resolved team ID
			assert.equal(robinsonBcla.pts, 21);
			assert.equal(robinsonBcla.min, '32.3'); // "32:15" parses to 32.3 minutes

			// Assert transformed NBB records
			const galvaniniNbb = transformed.players.find(p => p.game_id === 'NBB2024_20001' && p.player_id === 'gabriel-galvanini');
			assert.ok(galvaniniNbb);
			assert.equal(galvaniniNbb.team_id, 'flamengo');
			assert.equal(galvaniniNbb.pts, 22);
			assert.equal(galvaniniNbb.min, '30.3'); // "30:15" parses to 30.3 minutes

			const diasNbb = transformed.players.find(p => p.game_id === 'NBB2024_20001' && p.player_id === 'lucas-dias');
			assert.ok(diasNbb);
			assert.equal(diasNbb.team_id, 'franca');
			assert.equal(diasNbb.pts, 19);
			assert.equal(diasNbb.min, '31.8'); // "31:45" parses to 31.8 minutes

			// Assert transformed SPB (Venezuela) records
			const vargasSpb = transformed.players.find(p => p.game_id === 'SPB2024_30001' && p.player_id === 'gregory-vargas');
			assert.ok(vargasSpb);
			assert.equal(vargasSpb.team_id, 'gladiadores-anzoategui'); // resolved team ID
			assert.equal(vargasSpb.pts, 16);
			assert.equal(vargasSpb.min, '26.5'); // "26:30" parses to 26.5 minutes

			const cubillanSpb = transformed.players.find(p => p.game_id === 'SPB2024_30001' && p.player_id === 'david-cubillan');
			assert.ok(cubillanSpb);
			assert.equal(cubillanSpb.team_id, 'trotamundos-carabobo'); // resolved team ID
			assert.equal(cubillanSpb.pts, 12);
			assert.equal(cubillanSpb.min, '24.3'); // "24:15" parses to 24.3 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('southamerica', year);
				assert.ok(playerStats.length > 0);

				// Verify both games exist under 'southamerica' league roll-up
				assert.ok(playerStats.some(p => p.player_name === 'Gabriel Galvanini' && p.game_id.includes('BCLA')));
				assert.ok(playerStats.some(p => p.player_name === 'Gabriel Galvanini' && p.game_id.includes('NBB')));
				assert.ok(playerStats.some(p => p.player_name === 'Gregory Vargas' && p.game_id.includes('SPB')));
				assert.ok(playerStats.some(p => p.player_name === 'David Cubillan'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('southamerica', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'FLAMENGO' && t.game_id.includes('BCLA')));
				assert.ok(teamStats.some(t => t.team_name === 'GLADIADORES DE ANZOATEGUI' && t.game_id.includes('SPB')));
				assert.ok(teamStats.some(t => t.team_name === 'TROTAMUNDOS DE CARABOBO'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
