import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CeblScraper } from '../src/scrapers/canada/CeblScraper.mjs';
import { CeblHarvester } from '../src/scrapers/canada/harvesters/CeblHarvester.mjs';
import { parseCeblFibaJson } from '../src/scrapers/canada/parsers/CeblParser.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Canada CEBL Scraper & Pipeline Integration', () => {
	const league = 'canada_test';
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

	test('CeblHarvester should return mock slugs in test mode', async () => {
		const harvester = new CeblHarvester();
		const slugs = await harvester.getSeasonGameSlugs('2024');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-2024-'), 'Slugs must contain year segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^\d+$/, 'gameId Segment must match CEBL numeric pattern');
	});

	test('CeblScraper should return correct unified schema mock data', async () => {
		const scraper = new CeblScraper();
		const boxscore = await scraper.request('cebl-2024-10492');

		assert.equal(boxscore.gameId, 'cebl-2024-10492');
		assert.equal(boxscore.season, '2024');

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

	test('CeblScraper FIBA JSON Parser should correctly parse CEBL team names, scores, and player statistics from raw FIBA JSON', async () => {
		const sampleFibaJson = {
			gDate: "15/07/2024",
			tm: {
				"1": {
					sName: "VANCOUVER BANDITS",
					sShortName: "VAN",
					sScore: "95",
					pl: {
						"p1": {
							sFirstName: "Nick",
							sLastName: "Ward",
							sMinutes: "24:30",
							sPoints: "22",
							sFieldGoalsMade: "8",
							sFieldGoalsAttempted: "12",
							sThreePointersMade: "0",
							sThreePointersAttempted: "0",
							sFreeThrowsMade: "6",
							sFreeThrowsAttempted: "8",
							sReboundsOffensive: "3",
							sReboundsDefensive: "5",
							sReboundsTot: "8",
							sAssists: "2",
							sSteals: "1",
							sBlocksTot: "2",
							sTurnovers: "3",
							sFoulsPersonal: "4",
							sPlusMinus: "5"
						},
						"p2": {
							sFirstName: "Bench",
							sLastName: "Player",
							sMinutes: "00:00",
							sPoints: "0"
						}
					}
				},
				"2": {
					sName: "NIAGARA RIVER LIONS",
					sShortName: "NIA",
					sScore: "90",
					pl: {
						"p3": {
							sFirstName: "Jahvon",
							sLastName: "Blair",
							sMinutes: "28:15",
							sPoints: "18",
							sFieldGoalsMade: "6",
							sFieldGoalsAttempted: "14",
							sThreePointersMade: "3",
							sThreePointersAttempted: "7",
							sFreeThrowsMade: "3",
							sFreeThrowsAttempted: "4",
							sReboundsOffensive: "1",
							sReboundsDefensive: "4",
							sReboundsTot: "5",
							sAssists: "4",
							sSteals: "2",
							sBlocksTot: "0",
							sTurnovers: "2",
							sFoulsPersonal: "3",
							sPlusMinus: "-5"
						}
					}
				}
			}
		};

		const boxscore = parseCeblFibaJson(sampleFibaJson, 'cebl-2024-10492', '2024');

		assert.equal(boxscore.gameDate, '2024-07-15');
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
		assert.equal(ward.statistics.plus_minus, 5);

		// Bench player must be ignored because of 00:00 minutes
		const bench = boxscore.homeTeam.players.find(p => p.playerName === 'Bench Player');
		assert.ok(!bench, 'Should ignore DNP player');

		const blair = boxscore.awayTeam.players.find(p => p.playerName === 'Jahvon Blair');
		assert.ok(blair, 'Should parse Jahvon Blair successfully');
		assert.equal(blair.statistics.pts, 18);
		assert.equal(blair.statistics.min, '28:15');
		assert.equal(blair.statistics.fgm, 6);
		assert.equal(blair.statistics.fga, 14);
		assert.equal(blair.statistics.plus_minus, -5);
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
