import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { BblScraper } from '../src/scrapers/europe/BblScraper.mjs';
import { BblHarvester } from '../src/scrapers/europe/harvesters/BblHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('BBL German Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_bbl_test';
	const year = '2095'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('BblHarvester should return mock slugs in test mode', async () => {
		const harvester = new BblHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2095');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-D2095_'), 'Slugs must be formatted with D season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^D2095_[A-Z0-9_]+$/, 'gameId Segment must match BBL pattern');
	});

	test('BblScraper should return correct unified schema mock data', async () => {
		const scraper = new BblScraper();
		const boxscore = await scraper.getUnifiedBoxScore('fc-bayern-vs-alba-berlin-D2095_48210');

		assert.equal(boxscore.gameId, 'fc-bayern-vs-alba-berlin-D2095_48210');
		assert.equal(boxscore.competitionId, 'bbl');
		assert.equal(boxscore.seasonId, '2095');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'FC Bayern München');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const babb = boxscore.homeTeam.players.find(p => p.playerName.includes('Weiler-Babb'));
		assert.ok(babb);
		assert.equal(babb.playerId, 'nick-weiler-babb');
		assert.equal(babb.statistics.pts, 14);
		assert.equal(babb.statistics.min, '28:15');
	});

	test('BblScraper HTML Parser should correctly parse BBL team names, scores, and player statistics', async () => {
		const sampleHtml = `
			<html>
			<body>
				<div class="header">
					<span class="team-name">FC Bayern München</span>
					<div class="match-score">85 vs 78</div>
					<span class="team-name">ALBA Berlin</span>
				</div>

				<table>
					<tbody>
						<tr>
							<td>Nick Weiler-Babb</td>
							<td>28:15</td>
							<td>14</td>
							<td>5-10</td>
							<td>2-5</td>
							<td>2-2</td>
							<td>5</td>
							<td>6</td>
							<td>2</td>
							<td>1</td>
							<td>2</td>
							<td>3</td>
						</tr>
						<tr>
							<td>Louis Olinde</td>
							<td>25:30</td>
							<td>12</td>
							<td>4-9</td>
							<td>1-4</td>
							<td>3-4</td>
							<td>5</td>
							<td>2</td>
							<td>1</td>
							<td>0</td>
							<td>1</td>
							<td>2</td>
						</tr>
					</tbody>
				</table>
			</body>
			</html>
		`;

		const scraper = new BblScraper();

		// Setup cached raw HTML file so BblScraper reads from it directly instead of fetching
		const gameId = 'fc-bayern-vs-alba-berlin-D2095_48210';
		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const htmlCacheDir = path.resolve('data/raw/europe/bbl', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);
		await fs.writeFile(htmlCachePath, sampleHtml, 'utf8');

		try {
			// Temporarily disable test mode bypass to force BblScraper to use its HTML parser
			scraper.bypassNetwork = false;

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'bbl');
			assert.equal(boxscore.homeTeam.teamName, 'FC Bayern München');
			assert.equal(boxscore.awayTeam.teamName, 'ALBA Berlin');
			assert.equal(boxscore.homeTeam.score, 85);
			assert.equal(boxscore.awayTeam.score, 78);

			const babb = boxscore.homeTeam.players.find(p => p.playerName === 'Nick Weiler-Babb');
			assert.ok(babb, 'Should parse Babb successfully');
			assert.equal(babb.statistics.pts, 14);
			assert.equal(babb.statistics.min, '28:15');
			assert.equal(babb.statistics.fgm, 5);
			assert.equal(babb.statistics.fga, 10);
			assert.equal(babb.statistics.fg3m, 2);
			assert.equal(babb.statistics.fg3a, 5);
			assert.equal(babb.statistics.ftm, 2);
			assert.equal(babb.statistics.fta, 2);
			assert.equal(babb.statistics.reb, 5);
			assert.equal(babb.statistics.ast, 6);
			assert.equal(babb.statistics.stl, 2);
			assert.equal(babb.statistics.blk, 1);
			assert.equal(babb.statistics.tov, 2);
			assert.equal(babb.statistics.pf, 3);

			const olinde = boxscore.awayTeam.players.find(p => p.playerName === 'Louis Olinde');
			assert.ok(olinde, 'Should parse Olinde successfully');
			assert.equal(olinde.statistics.pts, 12);
			assert.equal(olinde.statistics.min, '25:30');
			assert.equal(olinde.statistics.fgm, 4);
			assert.equal(olinde.statistics.fga, 9);
			assert.equal(olinde.statistics.fg3m, 1);
			assert.equal(olinde.statistics.fg3a, 4);
			assert.equal(olinde.statistics.ftm, 3);
			assert.equal(olinde.statistics.fta, 4);
			assert.equal(olinde.statistics.reb, 5);
			assert.equal(olinde.statistics.ast, 2);
			assert.equal(olinde.statistics.stl, 1);
			assert.equal(olinde.statistics.blk, 0);
			assert.equal(olinde.statistics.tov, 1);
			assert.equal(olinde.statistics.pf, 2);
		} finally {
			// Restore test mode
			scraper.bypassNetwork = true;
			await fs.rm(htmlCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with D to BblScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'bbl' });
		const engine = scraper.getEngineForGame('fc-bayern-vs-alba-berlin-D2095_48210');
		assert.ok(engine instanceof BblScraper);
	});

	test('Full BBL Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'bbl' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('D2095_48210'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const babb = transformed.players.find(p => p.player_id === 'nick-weiler-babb');
			assert.ok(babb);
			assert.equal(babb.team_id, 'bayern-munich'); // resolved team ID
			assert.equal(babb.pts, 14);
			assert.equal(babb.min, '28.3'); // "28:15" parses to 28.3 minutes (half-up rounding)

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('bbl', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Nick Weiler-Babb'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('bbl', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'FC Bayern München'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('bbl', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'D2095_48210'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
