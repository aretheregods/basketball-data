import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { GblScraper } from '../src/scrapers/europe/GblScraper.mjs';
import { GblHarvester } from '../src/scrapers/europe/harvesters/GblHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('GBL Greek Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe';
	const year = '2097'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('GblHarvester should return mock slugs in test mode', async () => {
		const harvester = new GblHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2097');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-G2097_'), 'Slugs must be formatted with G season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^G2097_[A-Z0-9_]+$/, 'gameId Segment must match GBL pattern');
	});

	test('GblScraper should return correct unified schema mock data', async () => {
		const scraper = new GblScraper();
		const boxscore = await scraper.getUnifiedBoxScore('olympiacos-vs-panathinaikos-G2097_65708E5D');

		assert.equal(boxscore.gameId, 'olympiacos-vs-panathinaikos-G2097_65708E5D');
		assert.equal(boxscore.competitionId, 'gbl');
		assert.equal(boxscore.seasonId, '2097');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'OLYMPIACOS');
		assert.equal(boxscore.homeTeam.score, 82);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const walkup = boxscore.homeTeam.players.find(p => p.playerName.includes('Walkup'));
		assert.ok(walkup);
		assert.equal(walkup.playerId, 'thomas-walkup');
		assert.equal(walkup.statistics.pts, 5);
		assert.equal(walkup.statistics.min, '24:12');
	});

	test('GblScraper HTML Parser should correctly parse GBL team names, scores, jersey and player statistics', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span>OLYMPIACOS</span>
					<div class="score">82 vs 76</div>
					<span>PANATHINAIKOS AKTOR</span>
				</div>

				<div class="stats-section">
					<h2>ANALYTIC STATS <a href="/en/action/EsaketeamView?idteam=00000002&mode=1">OLYMPIACOS</a></h2>
					<table>
						<thead>
							<tr><th>PLAYER</th><th>P</th><th>2PM-A</th><th>3PM-A</th><th>FTM-A</th><th>REBS</th><th>D.REBS</th><th>O.REBS</th><th>AST</th><th>BLK</th><th>BLK-A</th><th>FOULS F</th><th>FOULS M</th><th>STL</th><th>TO</th><th>TIM.PL.</th><th>RANK</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>#0</td>
								<td><img src="pic.jpg"></td>
								<td>Thomas Walkup</td>
								<td>5</td>
								<td>0 - 1</td>
								<td>1 - 5</td>
								<td>2 - 2</td>
								<td>3</td>
								<td>1</td>
								<td>2</td>
								<td>6</td>
								<td>0</td>
								<td>0</td>
								<td>3</td>
								<td>1</td>
								<td>1</td>
								<td>2</td>
								<td>00:24:12</td>
								<td>8</td>
							</tr>
						</tbody>
					</table>

					<h2>ANALYTIC STATS <a href="/en/action/EsaketeamView?idteam=00000001&mode=1">PANATHINAIKOS AKTOR</a></h2>
					<table>
						<thead>
							<tr><th>PLAYER</th><th>P</th><th>2PM-A</th><th>3PM-A</th><th>FTM-A</th><th>REBS</th><th>D.REBS</th><th>O.REBS</th><th>AST</th><th>BLK</th><th>BLK-A</th><th>FOULS F</th><th>FOULS M</th><th>STL</th><th>TO</th><th>TIM.PL.</th><th>RANK</th></tr>
						</thead>
						<tbody>
							<tr>
								<td>#6</td>
								<td><img src="pic.jpg"></td>
								<td>Cendi Osman</td>
								<td>23</td>
								<td>7 - 9</td>
								<td>3 - 6</td>
								<td>0 - 0</td>
								<td>4</td>
								<td>4</td>
								<td>0</td>
								<td>2</td>
								<td>0</td>
								<td>1</td>
								<td>2</td>
								<td>1</td>
								<td>0</td>
								<td>0</td>
								<td>00:36:34</td>
								<td>24</td>
							</tr>
						</tbody>
					</table>
				</div>
			</body>
			</html>
		`;

		const scraper = new GblScraper();

		// Setup cached raw HTML file so GblScraper reads from it directly instead of fetching
		const gameId = 'olympiacos-vs-panathinaikos-G2097_65708E5D';
		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const htmlCacheDir = path.resolve('data/raw/europe/gbl', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);
		await fs.writeFile(htmlCachePath, sampleHtml, 'utf8');

		try {
			// Temporarily disable test mode bypass to force GblScraper to use its HTML parser
			process.env.NODE_ENV = 'production';

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'gbl');
			assert.equal(boxscore.homeTeam.teamName, 'OLYMPIACOS');
			assert.equal(boxscore.awayTeam.teamName, 'PANATHINAIKOS AKTOR');
			assert.equal(boxscore.homeTeam.score, 82);
			assert.equal(boxscore.awayTeam.score, 76);

			const walkup = boxscore.homeTeam.players.find(p => p.playerName === 'Thomas Walkup');
			assert.ok(walkup, 'Should parse Walkup successfully');
			assert.equal(walkup.statistics.pts, 5);
			assert.equal(walkup.statistics.min, '00:24:12');

			const osman = boxscore.awayTeam.players.find(p => p.playerName === 'Cendi Osman');
			assert.ok(osman, 'Should parse Osman successfully');
			assert.equal(osman.statistics.pts, 23);
			assert.equal(osman.statistics.min, '00:36:34');
		} finally {
			// Restore test mode
			process.env.NODE_ENV = 'test';
			await fs.rm(htmlCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with G to GblScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'gbl' });
		const engine = scraper.getEngineForGame('olympiacos-vs-panathinaikos-G2097_65708E5D');
		assert.ok(engine instanceof GblScraper);
	});

	test('Full GBL Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'gbl' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('G2097_65708E5D'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const walkup = transformed.players.find(p => p.player_id === 'thomas-walkup');
			assert.ok(walkup);
			assert.equal(walkup.team_id, 'olympiacos'); // resolved team ID
			assert.equal(walkup.pts, 5);
			assert.equal(walkup.min, '24.2'); // "24:12" parses to 24.2 minutes

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('gbl', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Thomas Walkup'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('gbl', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'OLYMPIACOS'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('gbl', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'G2097_65708E5D'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
