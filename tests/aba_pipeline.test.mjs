import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { AbaScraper } from '../src/scrapers/europe/AbaScraper.mjs';
import { AbaHarvester } from '../src/scrapers/europe/harvesters/AbaHarvester.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('ABA Adriatic Basketball Scraper & Pipeline Integration', () => {
	const league = 'europe_aba_test';
	const year = '2024'; // Unique test year to isolate test runs

	test.before(async () => {
		process.env.NODE_ENV = 'test';
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test.after(async () => {
		await fs.rm(path.resolve('data/raw', league, year), { recursive: true, force: true });
		await fs.rm(path.resolve('data/transformed', league, year), { recursive: true, force: true });
	});

	test('AbaHarvester should return mock slugs in test mode', async () => {
		const harvester = new AbaHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-V2024_'), 'Slugs must be formatted with V season prefix segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^V2024_\d+$/, 'gameId Segment must match ABA pattern');
	});

	test('AbaScraper should return correct unified schema mock data', async () => {
		const scraper = new AbaScraper();
		const boxscore = await scraper.getUnifiedBoxScore('partizan-vs-crvena-zvezda-V2024_123');

		assert.equal(boxscore.gameId, 'partizan-vs-crvena-zvezda-V2024_123');
		assert.equal(boxscore.competitionId, 'aba');
		assert.equal(boxscore.seasonId, '2024');

		// Home team check
		assert.equal(boxscore.homeTeam.teamName, 'Crvena Zvezda');
		assert.equal(boxscore.homeTeam.score, 85);
		assert.ok(boxscore.homeTeam.players.length > 0);

		// Player stats checks
		const reb = boxscore.homeTeam.players.find(p => p.playerName.includes('Rebraca'));
		assert.ok(reb);
		assert.equal(reb.playerId, 'filip-rebraca');
		assert.equal(reb.statistics.pts, 14);
		assert.equal(reb.statistics.min, '28:36');
	});

	test('AbaScraper HTML Parser should correctly parse ABA team names, scores, and player statistics from cache', async () => {
		const makeRow = (name, min, pts, pt2, pt3, ft, oreb, dreb, reb, ast, stl, blk, tov, pf, plusMinus) => {
			const cells = Array(25).fill('<td>0</td>');
			cells[0] = '<td>1</td>';
			cells[1] = `<td>${name}</td>`;
			cells[2] = `<td>${min}</td>`;
			cells[3] = `<td>${pts}</td>`;
			cells[4] = `<td>${pt2}</td>`;
			cells[7] = `<td>${pt3}</td>`;
			cells[10] = `<td>${ft}</td>`;
			cells[13] = `<td>${oreb}</td>`;
			cells[14] = `<td>${dreb}</td>`;
			cells[15] = `<td>${reb}</td>`;
			cells[16] = `<td>${ast}</td>`;
			cells[17] = `<td>${stl}</td>`;
			cells[18] = `<td>${tov}</td>`;
			cells[19] = `<td>${blk}</td>`;
			cells[21] = `<td>${pf}</td>`;
			cells[23] = `<td>${plusMinus}</td>`;
			return `<tr>${cells.join('')}</tr>`;
		};

		const testHtml = `
			<html>
				<body>
					<div class="time_match">15.11.2024</div>
					<div class="title_match">PARTIZAN MOZZART BET - CRVENA ZVEZDA</div>

					<h3>PARTIZAN MOZZART BET</h3>
					<table>
						<tbody>
							${makeRow('Antonio Sikiric', '25:12', '12', '3/5', '1/3', '3/4', '2', '3', '5', '2', '1', '0', '1', '2', '-8')}
							${makeRow('TOTAL', '200:00', '82', '14/28', '9/22', '17/20', '7', '20', '27', '15', '6', '2', '14', '22', '-3')}
						</tbody>
					</table>

					<h3>CRVENA ZVEZDA</h3>
					<table>
						<tbody>
							${makeRow('Filip Rebraca', '28:36', '14', '3/5', '2/5', '2/2', '1', '4', '5', '6', '2', '1', '2', '3', '8')}
							${makeRow('TOTAL', '200:00', '85', '15/30', '10/25', '15/18', '8', '22', '30', '18', '8', '3', '12', '20', '3')}
						</tbody>
					</table>
				</body>
			</html>
		`;

		const scraper = new AbaScraper();

		// Setup cached raw HTML file so AbaScraper reads from it directly instead of fetching
		const gameId = 'partizan-vs-crvena-zvezda-V2024_123';
		const { yearPrefix, gameCode } = scraper.parseGameId(gameId);
		const htmlCacheDir = path.resolve('data/raw/europe/aba', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);
		await fs.writeFile(htmlCachePath, testHtml, 'utf8');

		try {
			// Temporarily disable test mode bypass to force AbaScraper to use Playwright on cache
			scraper.bypassNetwork = false;

			const boxscore = await scraper.getUnifiedBoxScore(gameId);

			assert.equal(boxscore.competitionId, 'aba');
			assert.equal(boxscore.homeTeam.teamName, 'CRVENA ZVEZDA');
			assert.equal(boxscore.awayTeam.teamName, 'PARTIZAN MOZZART BET');
			assert.equal(boxscore.homeTeam.score, 85);
			assert.equal(boxscore.awayTeam.score, 82);
			assert.equal(boxscore.gameDate, '2024-11-15');

			const sik = boxscore.awayTeam.players.find(p => p.playerName === 'Antonio Sikiric');
			assert.ok(sik, 'Should parse Antonio Sikiric successfully');
			assert.equal(sik.statistics.pts, 12);
			assert.equal(sik.statistics.min, '25:12');

			const reb = boxscore.homeTeam.players.find(p => p.playerName === 'Filip Rebraca');
			assert.ok(reb, 'Should parse Filip Rebraca successfully');
			assert.equal(reb.statistics.pts, 14);
			assert.equal(reb.statistics.min, '28:36');
		} finally {
			// Restore test mode and clean up
			scraper.bypassNetwork = true;
			await fs.rm(htmlCacheDir, { recursive: true, force: true });
		}
	});

	test('EuropeScraper should route gameId prefixed with V to AbaScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'aba' });
		const engine = scraper.getEngineForGame('partizan-vs-crvena-zvezda-V2024_123');
		assert.ok(engine instanceof AbaScraper);
	});

	test('Full ABA Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new EuropeScraper({ competitions: 'aba' });

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('V2024_123'));

			// 2. STAGE 2: Transform
			const transformed = await transformStage(league, year);
			assert.ok(transformed.players.length > 0);
			assert.ok(transformed.teams.length > 0);

			// Assert transformed records
			const reb = transformed.players.find(p => p.player_id === 'filip-rebraca');
			assert.ok(reb);
			assert.equal(reb.team_id, 'crvena-zvezda'); // resolved team ID
			assert.equal(reb.pts, 14);
			assert.equal(reb.min, '28.6'); // "28:36" parses to 28.6 minutes (half-up rounding)

			// 3. STAGE 3: Load
			await loadStage(league, year, transformed);

			// 4. Verify in Database
			const db = await initDatabase(league);
			try {
				const playerStats = db.prepare('SELECT * FROM player_game_stats WHERE league = ? AND season = ?').all('aba', year);
				assert.ok(playerStats.length > 0);
				assert.ok(playerStats.some(p => p.player_name === 'Filip Rebraca'));

				const teamStats = db.prepare('SELECT * FROM team_game_stats WHERE league = ? AND season = ?').all('aba', year);
				assert.ok(teamStats.length > 0);
				assert.ok(teamStats.some(t => t.team_name === 'Crvena Zvezda'));

				const games = db.prepare('SELECT * FROM games WHERE competition_id = ? AND season_id = ?').all('aba', year);
				assert.ok(games.length > 0);
				assert.ok(games.some(g => g.id === 'V2024_123'));
			} finally {
				db.destroy();
			}
		} catch (err) {
			console.error('DEBUGGING TEST ERROR:', err);
			throw err;
		}
	});
});
