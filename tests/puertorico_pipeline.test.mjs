process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BsnScraper } from '../src/scrapers/puertorico/BsnScraper.mjs';
import { BsnHarvester } from '../src/scrapers/puertorico/harvesters/BsnHarvester.mjs';
import { parseBsnFibaJson } from '../src/scrapers/puertorico/parsers/BsnParser.mjs';
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
		// Set scraper bypassNetwork to mimic test mode fully
		harvester.scraper = { bypassNetwork: true };
		const slugs = await harvester.getSeasonGameSlugs('2099');

		assert.ok(slugs.length > 0, 'Should return some slugs');
		assert.ok(slugs[0].includes('-2099-'), 'Slugs must contain year segment');
		const sampleGameId = slugs[0].split('-').pop();
		assert.match(sampleGameId, /^\d+$/, 'gameId Segment must match BSN numeric pattern');
	});

	test('BsnScraper should return correct unified schema mock data', async () => {
		const scraper = new BsnScraper();
		const boxscore = await scraper.request('bsn-2099-2111481');

		assert.equal(boxscore.gameId, 'bsn-2099-2111481');
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

	test('BsnScraper FIBA JSON Parser should correctly parse BSN team names, scores, and player statistics from raw FIBA JSON', async () => {
		const sampleFibaJson = {
			gDate: "15/07/2099",
			tm: {
				"1": {
					sName: "VAQUEROS DE BAYAMON",
					sShortName: "BAY",
					sScore: "95",
					pl: {
						"p1": {
							sFirstName: "Tremont",
							sLastName: "Waters",
							sMinutes: "24:30",
							sPoints: "22",
							sFieldGoalsMade: "8",
							sFieldGoalsAttempted: "12",
							sThreePointersMade: "2",
							sThreePointersAttempted: "4",
							sFreeThrowsMade: "4",
							sFreeThrowsAttempted: "4",
							sReboundsOffensive: "1",
							sReboundsDefensive: "4",
							sReboundsTot: "5",
							sAssists: "6",
							sSteals: "2",
							sBlocksTot: "0",
							sTurnovers: "2",
							sFoulsPersonal: "3",
							sPlusMinus: "8"
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
					sName: "CAPITANES DE ARECIBO",
					sShortName: "ARE",
					sScore: "90",
					pl: {
						"p3": {
							sFirstName: "Ángel",
							sLastName: "Rodríguez",
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
							sPlusMinus: "-8"
						}
					}
				}
			}
		};

		const boxscore = parseBsnFibaJson(sampleFibaJson, 'bsn-2099-2111481', '2099');

		assert.equal(boxscore.gameDate, '2099-07-15');
		assert.equal(boxscore.homeTeam.teamName, 'VAQUEROS DE BAYAMON');
		assert.equal(boxscore.awayTeam.teamName, 'CAPITANES DE ARECIBO');
		assert.equal(boxscore.homeTeam.score, 95);
		assert.equal(boxscore.awayTeam.score, 90);

		const waters = boxscore.homeTeam.players.find(p => p.playerName === 'Tremont Waters');
		assert.ok(waters, 'Should parse Tremont Waters successfully');
		assert.equal(waters.statistics.pts, 22);
		assert.equal(waters.statistics.min, '24:30');
		assert.equal(waters.statistics.fgm, 8);
		assert.equal(waters.statistics.fga, 12);
		assert.equal(waters.statistics.plus_minus, 8);

		// Bench player must be ignored because of 00:00 minutes
		const bench = boxscore.homeTeam.players.find(p => p.playerName === 'Bench Player');
		assert.ok(!bench, 'Should ignore DNP player');

		const rodriguez = boxscore.awayTeam.players.find(p => p.playerName === 'Ángel Rodríguez');
		assert.ok(rodriguez, 'Should parse Ángel Rodríguez successfully');
		assert.equal(rodriguez.statistics.pts, 18);
		assert.equal(rodriguez.statistics.min, '28:15');
		assert.equal(rodriguez.statistics.fgm, 6);
		assert.equal(rodriguez.statistics.fga, 14);
		assert.equal(rodriguez.statistics.plus_minus, -8);
	});

	test('Full Puerto Rico Pipeline Integration: Extract -> Transform -> Load', async () => {
		try {
			const scraper = new BsnScraper();

			// 1. STAGE 1: Extract
			const gameIds = await extractStage(scraper, league, year);
			assert.ok(gameIds.length > 0);
			assert.ok(gameIds.includes('2111481'));

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
