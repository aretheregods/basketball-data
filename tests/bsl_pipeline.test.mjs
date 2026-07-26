import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { BslScraper } from '../src/scrapers/europe/BslScraper.mjs';
import { BslHarvester } from '../src/scrapers/europe/harvesters/BslHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('BSL Turkish Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_bsl_test';
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

	test('BslHarvester should return mock slugs in test mode', async () => {
		const harvester = new BslHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2095');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-S2095_'), 'Slugs must be formatted with S season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^S2095_\d+$/, 'gameId Segment must match BSL pattern');
	});

	test('BslScraper should return correct unified schema mock data', async () => {
		const scraper = new BslScraper();
		const boxscore = await scraper.getUnifiedBoxScore('besiktas-vs-galatasaray-S2095_412345');

		assert.equal(boxscore.gameId, 'besiktas-vs-galatasaray-S2095_412345');
		assert.equal(boxscore.competitionId, 'bsl');
		assert.equal(boxscore.seasonId, '2095');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'Galatasaray');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const player = boxscore.homeTeam.players.find(p => p.playerName.includes('Kabaca'));
		assert.ok(player);
		assert.equal(player.playerId, 'sadik-emir-kabaca');
		assert.equal(player.statistics.pts, 14);
		assert.equal(player.statistics.min, '28:36');
	});

	test('BslScraper HTML Parser should correctly parse BSL team names, scores, and player statistics from Proballers cache', async () => {
		const makeRow = (name, min, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pts) => {
			return `
				<tr>
					<td><a href="/player/foo">${name}</a></td>
					<td>${min}</td>
					<td>${fgm}</td>
					<td>${fga}</td>
					<td>${fg3m}</td>
					<td>${fg3a}</td>
					<td>${ftm}</td>
					<td>${fta}</td>
					<td>${oreb}</td>
					<td>${dreb}</td>
					<td>0</td> <!-- total reb will be calculated -->
					<td>${ast}</td>
					<td>${stl}</td>
					<td>${blk}</td>
					<td>${tov}</td>
					<td>${pf}</td>
					<td>${pts}</td>
				</tr>
			`;
		};

		const makeTotalsRow = (fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pts) => {
			return `
				<tr>
					<td>Totals</td>
					<td>200</td>
					<td>${fgm}</td>
					<td>${fga}</td>
					<td>${fg3m}</td>
					<td>${fg3a}</td>
					<td>${ftm}</td>
					<td>${fta}</td>
					<td>${oreb}</td>
					<td>${dreb}</td>
					<td>0</td>
					<td>${ast}</td>
					<td>${stl}</td>
					<td>${blk}</td>
					<td>${tov}</td>
					<td>${pf}</td>
					<td>${pts}</td>
				</tr>
			`;
		};

		const testHtml = `
			<html>
				<head>
					<title>Besiktas vs Galatasaray Box Score - May 10, 2095 - Proballers</title>
				</head>
				<body>
					<div class="identity-title">Besiktas</div>
					<table>
						<thead>
							<tr>
								<th>Player</th>
								<th>MIN</th>
								<th>FGM</th>
								<th>FGA</th>
								<th>3PM</th>
								<th>3PA</th>
								<th>FTM</th>
								<th>FTA</th>
								<th>OFF</th>
								<th>DEF</th>
								<th>REB</th>
								<th>AST</th>
								<th>STL</th>
								<th>BLK</th>
								<th>TO</th>
								<th>PF</th>
								<th>PTS</th>
							</tr>
						</thead>
						<tbody>
							${makeRow('Jonah Mathews', '25:12', '4', '8', '1', '3', '3', '4', '2', '3', '2', '1', '0', '1', '2', '12')}
							${makeTotalsRow('28', '58', '9', '22', '17', '20', '7', '20', '15', '6', '2', '14', '22', '82')}
						</tbody>
					</table>

					<div class="identity-title">Galatasaray</div>
					<table>
						<thead>
							<tr>
								<th>Player</th>
								<th>MIN</th>
								<th>FGM</th>
								<th>FGA</th>
								<th>3PM</th>
								<th>3PA</th>
								<th>FTM</th>
								<th>FTA</th>
								<th>OFF</th>
								<th>DEF</th>
								<th>REB</th>
								<th>AST</th>
								<th>STL</th>
								<th>BLK</th>
								<th>TO</th>
								<th>PF</th>
								<th>PTS</th>
							</tr>
						</thead>
						<tbody>
							${makeRow('Sadik Emir Kabaca', '28:36', '5', '10', '2', '5', '2', '2', '1', '4', '6', '2', '1', '2', '3', '14')}
							${makeTotalsRow('30', '60', '10', '25', '15', '18', '8', '22', '18', '8', '3', '12', '20', '85')}
						</tbody>
					</table>
				</body>
			</html>
		`;

		const scraper = new BslScraper();

		// Setup cached raw HTML file so BslScraper reads from it directly instead of fetching
		const gameId = 'besiktas-vs-galatasaray-S2095_412345';
		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const htmlCacheDir = path.resolve('data/raw/europe/bsl', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);
		await fs.writeFile(htmlCachePath, testHtml, 'utf8');

		try {
			// Temporarily disable test mode bypass to force BslScraper to parse cache HTML
			scraper.bypassNetwork = false;

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'bsl');
			assert.equal(boxscore.homeTeam.teamName, 'Galatasaray');
			assert.equal(boxscore.awayTeam.teamName, 'Besiktas');
			assert.equal(boxscore.homeTeam.score, 85);
			assert.equal(boxscore.awayTeam.score, 82);
			assert.equal(boxscore.gameDate, '2095-05-10');

			const mathews = boxscore.awayTeam.players.find(p => p.playerName === 'Jonah Mathews');
			assert.ok(mathews, 'Should parse Jonah Mathews successfully');
			assert.equal(mathews.statistics.pts, 12);
			assert.equal(mathews.statistics.min, '25:12');

			const kabaca = boxscore.homeTeam.players.find(p => p.playerName === 'Sadik Emir Kabaca');
			assert.ok(kabaca, 'Should parse Sadik Emir Kabaca successfully');
			assert.equal(kabaca.statistics.pts, 14);
			assert.equal(kabaca.statistics.min, '28:36');
		} finally {
			// Restore test mode and clean up
			scraper.bypassNetwork = true;
			await fs.rm(htmlCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with S to BslScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'bsl' });
		const engine = scraper.getEngineForGame('besiktas-vs-galatasaray-S2095_412345');
		assert.ok(engine instanceof BslScraper);
	});

	test('Full BSL Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'bsl' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('S2095_412345'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const kabaca = transformed.players.find(p => p.player_id === 'sadik-emir-kabaca');
			assert.ok(kabaca);
			assert.equal(kabaca.team_id, 'galatasaray'); // resolved team ID via mappings
			assert.equal(kabaca.pts, 14);
			assert.equal(kabaca.min, '28.6'); // "28:36" parses to 28.6 minutes (half-up rounding)

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('bsl', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Sadik Emir Kabaca'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('bsl', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'Galatasaray'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('bsl', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'S2095_412345'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
