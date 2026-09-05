import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { EuroleaguePbpHarvester } from '../src/scrapers/europe/pbp/EuroleaguePbpHarvester.mjs';
import { AcbPbpHarvester } from '../src/scrapers/europe/pbp/AcbPbpHarvester.mjs';
import { LnbPbpHarvester } from '../src/scrapers/europe/pbp/LnbPbpHarvester.mjs';
import {
	calculateGameSecondsRemaining,
	parseEuroClock,
	transformEuroleaguePbp
} from '../src/scrapers/europe/pbp/EuroleaguePbpTransformer.mjs';
import {
	parseAcbClock,
	normalizeAcbAction,
	transformAcbPbp
} from '../src/scrapers/europe/pbp/AcbPbpTransformer.mjs';
import {
	parseLnbClock,
	normalizeLnbAction,
	transformLnbPbp
} from '../src/scrapers/europe/pbp/LnbPbpTransformer.mjs';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { AuditEngine } from '../src/audit/AuditEngine.mjs';

process.env.NODE_ENV = 'test';

test('EuroLeague, ACB & LNB PBP Clock and Helper Unit Tests', async (t) => {
	await t.test('parseEuroClock, parseAcbClock and parseLnbClock should parse clock string MM:SS into remaining period seconds', () => {
		assert.equal(parseEuroClock(null, '10:00'), 600);
		assert.equal(parseEuroClock(null, '08:45'), 525);
		assert.equal(parseEuroClock(null, '00:00'), 0);

		assert.equal(parseAcbClock('10:00'), 600);
		assert.equal(parseAcbClock('09:45'), 585);
		assert.equal(parseAcbClock('00:00'), 0);

		assert.equal(parseLnbClock('10:00'), 600);
		assert.equal(parseLnbClock('09:45'), 585);
		assert.equal(parseLnbClock('00:00'), 0);
	});

	await t.test('normalizeAcbAction should map Spanish event descriptions to standard event codes', () => {
		assert.equal(normalizeAcbAction('Canasta de 3 puntos de Kevin Punter'), '3FGM');
		assert.equal(normalizeAcbAction('Triple fallado por Jean Montero'), '3FGA');
		assert.equal(normalizeAcbAction('Canasta de 2 puntos'), '2FGM');
		assert.equal(normalizeAcbAction('Tiro libre anotado'), 'FTM');
		assert.equal(normalizeAcbAction('Rebote ofensivo'), 'ORB');
		assert.equal(normalizeAcbAction('Rebote defensivo'), 'DRB');
		assert.equal(normalizeAcbAction('Pérdida de balón'), 'TOV');
		assert.equal(normalizeAcbAction('Falta personal'), 'FOUL');
		assert.equal(normalizeAcbAction('Tapón de Tavares'), 'BLK');
		assert.equal(normalizeAcbAction('Cambio: Entra Montero'), 'SUB');
	});

	await t.test('normalizeLnbAction should map French event descriptions to standard event codes', () => {
		assert.equal(normalizeLnbAction('Tir à 3pts réussi par Mike James'), '3FGM');
		assert.equal(normalizeLnbAction('Tir à 3pts manqué'), '3FGA');
		assert.equal(normalizeLnbAction('Tir à 2pts réussi / Dunk'), '2FGM');
		assert.equal(normalizeLnbAction('Lancer franc réussi'), 'FTM');
		assert.equal(normalizeLnbAction('Lancer franc manqué'), 'FTA');
		assert.equal(normalizeLnbAction('Rebond offensif'), 'ORB');
		assert.equal(normalizeLnbAction('Rebond défensif'), 'DRB');
		assert.equal(normalizeLnbAction('Balle perdue'), 'TOV');
		assert.equal(normalizeLnbAction('Faute personnelle'), 'FOUL');
		assert.equal(normalizeLnbAction('Contre / Tir contré'), 'BLK');
		assert.equal(normalizeLnbAction('Changement : Élie Okobo entre sur le terrain'), 'SUB');
	});

	await t.test('calculateGameSecondsRemaining should accurately calculate total game clock for FIBA regulation and OT', () => {
		// Q1 (Period 1): 10:00 remaining -> 3*600 + 600 = 2400
		assert.equal(calculateGameSecondsRemaining(1, 600), 2400);
		// Q4 (Period 4): 02:00 remaining -> 0*600 + 120 = 120
		assert.equal(calculateGameSecondsRemaining(4, 120), 120);
		// OT1 (Period 5): 03:00 remaining -> 180
		assert.equal(calculateGameSecondsRemaining(5, 180), 180);
	});
});

test('French LNB PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('LnbPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new LnbPbpHarvester();
		assert.deepEqual(harvester.parseGameId('L2025_1001'), {
			competitionId: 'LNB2025',
			seasonCode: 'LNB2025',
			gameCode: '1001',
			seasonYear: '2025'
		});
		assert.deepEqual(harvester.parseGameId('1001', '2024'), {
			competitionId: 'LNB2024',
			seasonCode: 'LNB2024',
			gameCode: '1001',
			seasonYear: '2024'
		});
	});

	await t.test('transformLnbPbp should normalize French LNB event stream and generate 5-on-5 stints', () => {
		const rawPayload = {
			seasonYear: '2025',
			competitionId: 'LNB2025',
			actions: [
				{
					id: 1,
					periode: 1,
					chrono: "09:45",
					type: "2FGM",
					sousType: "Dunk",
					libelle: "Tir à 2pts réussi par Mike James",
					equipeId: "MON",
					joueurId: "mike-james",
					scoreDomicile: 2,
					scoreExterieur: 0,
					coordX: 12.5,
					coordY: 15.0,
					distance: 2.5
				},
				{
					id: 2,
					periode: 1,
					chrono: "09:30",
					type: "SUB",
					sousType: "IN",
					libelle: "Changement : Élie Okobo entre sur le terrain",
					equipeId: "ASV",
					joueurId: "elie-okobo",
					scoreDomicile: 2,
					scoreExterieur: 0
				}
			]
		};

		const { events, stints } = transformLnbPbp('L2025_1001', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].competition_id, 'LNB2025');
		assert.equal(events[0].loc_x, 12.5);
		assert.equal(events[0].loc_y, 15.0);
		assert.equal(events[0].shot_distance, 2.5);
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});
});

test('Spanish ACB PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('AcbPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new AcbPbpHarvester();
		assert.deepEqual(harvester.parseGameId('A2025_105373'), {
			competitionId: 'ACB2025',
			seasonCode: 'ACB2025',
			gameCode: '105373',
			seasonYear: '2025'
		});
		assert.deepEqual(harvester.parseGameId('105373', '2024'), {
			competitionId: 'ACB2024',
			seasonCode: 'ACB2024',
			gameCode: '105373',
			seasonYear: '2024'
		});
	});

	await t.test('transformAcbPbp should normalize Spanish ACB event stream and generate 5-on-5 stints', () => {
		const rawPayload = {
			seasonYear: '2025',
			competitionId: 'ACB2025',
			jugadas: [
				{
					id: 101,
					periodo: 1,
					tiempo: "09:45",
					tipo: "2FGM",
					subtipo: "Mate",
					texto: "Canasta de 2 puntos de Kevin Punter",
					idEquipo: "BAR",
					idJugador: "30003361",
					puntosLocal: 2,
					puntosVisitante: 0,
					posX: 12.5,
					posY: 15.0,
					distancia: 2.5
				},
				{
					id: 102,
					periodo: 1,
					tiempo: "09:30",
					tipo: "SUB",
					subtipo: "IN",
					texto: "Cambio: Entra Jean Montero",
					idEquipo: "VBC",
					idJugador: "30002844",
					puntosLocal: 2,
					puntosVisitante: 0
				}
			]
		};

		const { events, stints } = transformAcbPbp('A2025_105373', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].competition_id, 'ACB2025');
		assert.equal(events[0].loc_x, 12.5);
		assert.equal(events[0].loc_y, 15.0);
		assert.equal(events[0].shot_distance, 2.5);
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});
});

test('EuroLeague PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('EuroleaguePbpHarvester parseGameId should parse game codes and normalize 2-digit years to 4-digit API season codes', () => {
		const harvester = new EuroleaguePbpHarvester();
		assert.deepEqual(harvester.parseGameId('realmadrid-vs-panathinaikos-E2024_1'), {
			competition: 'euroleague',
			seasonCode: 'E2024',
			gameCode: '1'
		});
		assert.deepEqual(harvester.parseGameId('matchup-U2024_15'), {
			competition: 'eurocup',
			seasonCode: 'U2024',
			gameCode: '15'
		});
		assert.deepEqual(harvester.parseGameId('matchup-E25_1'), {
			competition: 'euroleague',
			seasonCode: 'E2025',
			gameCode: '1'
		});
		assert.deepEqual(harvester.parseGameId('matchup-U25_10'), {
			competition: 'eurocup',
			seasonCode: 'U2025',
			gameCode: '10'
		});
	});

	await t.test('transformEuroleaguePbp should normalize event streams and derive 5-on-5 stints from Rows array', () => {
		const rawPayload = {
			seasonCode: 'E2024',
			pbp: {
				Rows: [
					{
						NUMBEROFPLAY: 1,
						PERIOD: 1,
						MINUTE: 1,
						MARKERTIME: '09:45',
						PLAYTYPE: '2FGM',
						TYPE: 'Layup',
						TEAM: 'RMD',
						PLAYER_ID: 'P001',
						PASSING_PLAYER_ID: 'P002',
						POINTS_A: 2,
						POINTS_B: 0,
						PLAYINFO: 'Layup made'
					},
					{
						NUMBEROFPLAY: 2,
						PERIOD: 1,
						MINUTE: 2,
						MARKERTIME: '09:30',
						PLAYTYPE: 'SUB',
						TYPE: 'IN',
						TEAM: 'PAN',
						PLAYER_ID: 'P003',
						POINTS_A: 2,
						POINTS_B: 0,
						PLAYINFO: 'Sub in'
					}
				]
			},
			points: {
				Rows: [
					{ NUM_ANOT: 1, COORD_X: 15.0, COORD_Y: 20.0, DISTANCE: 3.5 }
				]
			}
		};

		const { events, stints } = transformEuroleaguePbp('E2024_1', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].loc_x, 15.0);
		assert.equal(events[0].loc_y, 20.0);
		assert.equal(events[0].shot_distance, 3.5);
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});

	await t.test('transformEuroleaguePbp should support Quarter-based object payloads (FirstQuarter, SecondQuarter, etc.)', () => {
		const quarterPayload = {
			seasonCode: 'E2021',
			pbp: {
				FirstQuarter: [
					{
						NUMBEROFPLAY: 1,
						MARKERTIME: '09:50',
						MINUTE: 1,
						PLAYTYPE: '2FGM',
						CODETEAM: 'MCO',
						PLAYER_ID: 'P100',
						POINTS_A: 2,
						POINTS_B: 0,
						PLAYINFO: 'Jump Shot Made'
					}
				],
				SecondQuarter: [
					{
						NUMBEROFPLAY: 2,
						MARKERTIME: '08:15',
						MINUTE: 2,
						PLAYTYPE: '3FGM',
						CODETEAM: 'PAN',
						PLAYER_ID: 'P200',
						POINTS_A: 2,
						POINTS_B: 3,
						PLAYINFO: '3PT Shot Made'
					}
				]
			}
		};

		const { events, stints } = transformEuroleaguePbp('E2021_1', quarterPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].period, 1);
		assert.equal(events[0].team_id, 'MCO');
		assert.equal(events[0].player_id, 'P100');
		assert.equal(events[1].period, 2);
		assert.equal(events[1].team_id, 'PAN');
		assert.equal(events[1].player_id, 'P200');

		assert.equal(stints.length, 2);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[1].period, 2);
	});
});

test('Europe, ACB & LNB PBP Full Pipeline Integration Test', async (t) => {
	const league = 'europe_pbp_test';
	const year = '2024';

	// Setup clean mock scraper
	const scraper = new EuropeScraper({ competitions: 'acb,lnb,euroleague', boxscoreType: 'pbp' });
	scraper.pbpHarvester.bypassNetwork = true;
	scraper.acbPbpHarvester.bypassNetwork = true;
	scraper.lnbPbpHarvester.bypassNetwork = true;
	scraper.getSeasonGameSlugs = async function() {
		this.gameSlugs = [
			'realmadrid-vs-panathinaikos-E2024_1',
			'barcelona-vs-valencia-A2024_105373',
			'asvel-vs-monaco-L2024_1001'
		];
		return this;
	};

	// Clean test directory and test DB before run
	const testRawDir = path.resolve(`data/raw/${league}/pbp/${year}`);
	const testTransformedDir = path.resolve(`data/transformed/${league}/pbp/${year}`);
	const testDbPath = path.resolve(`data/SQL/${league.toUpperCase()}.sqlite`);

	await fs.rm(testRawDir, { recursive: true, force: true });
	await fs.rm(testTransformedDir, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });

	await t.test('Full Europe, ACB & LNB PBP Pipeline Execution: Extract -> Transform -> Load -> SQLite Audit', async () => {
		// Stage 1: Extract
		const extractedGameIds = await extractStage(scraper, league, year, { type: 'pbp', competitions: 'acb,lnb,euroleague' });
		assert.equal(extractedGameIds.length, 3);
		assert.ok(extractedGameIds.includes('E2024_1'));
		assert.ok(extractedGameIds.includes('A2024_105373'));
		assert.ok(extractedGameIds.includes('L2024_1001'));

		// Stage 2: Transform
		const transformedData = await transformStage(league, year, { type: 'pbp', competitions: 'acb,lnb,euroleague' });
		assert.ok(transformedData.events.length > 0);
		assert.ok(transformedData.stints.length > 0);

		// Stage 3: Load
		await loadStage(league, year, transformedData, { type: 'pbp', competitions: 'acb,lnb,euroleague' });

		// Stage 4: Direct DB verification
		const db = await initDatabase(league);
		try {
			const elEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('E2024_1');
			assert.equal(elEventsCount.count, 2);

			const acbEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('A2024_105373');
			assert.equal(acbEventsCount.count, 2);

			const lnbEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('L2024_1001');
			assert.equal(lnbEventsCount.count, 2);

			const elStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('E2024_1');
			assert.equal(elStintsCount.count, 1);

			const acbStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('A2024_105373');
			assert.equal(acbStintsCount.count, 1);

			const lnbStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('L2024_1001');
			assert.equal(lnbStintsCount.count, 1);

			// Populate team_game_stats record to test AuditEngine PBP stats query
			db.prepare(`
				INSERT INTO team_game_stats (
					game_id, team_id, team_name, team_abbreviation, team_city, min,
					fgm, fga, fg_pct, fg3m, fg3a, fg3_pct, ftm, fta, ft_pct,
					oreb, dreb, reb, ast, stl, blk, tov, pf, pts, plus_minus,
					ts_pct, efg_pct, season, league, synced
				) VALUES (
					'E2024_1', 'RMD', 'Real Madrid', 'RMD', 'Madrid', '200:00',
					30, 60, 0.5, 10, 25, 0.4, 15, 20, 0.75,
					8, 25, 33, 20, 5, 3, 10, 15, 85, 5,
					0.6, 0.55, '2024', 'europe_pbp_test', 0
				)
			`).run();

			const engine = new AuditEngine(testDbPath);
			const fullAudit = engine.runFullAudit();

			assert.ok(fullAudit.totalPbpEvents > 0);
			assert.ok(fullAudit.totalPbpStints > 0);
		} finally {
			if (db) db.destroy();
		}
	});

	// Cleanup test artifacts
	await fs.rm(testRawDir, { recursive: true, force: true });
	await fs.rm(testTransformedDir, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });
});
