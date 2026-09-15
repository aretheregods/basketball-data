import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { EuroleaguePbpHarvester } from '../src/scrapers/europe/pbp/EuroleaguePbpHarvester.mjs';
import { AcbPbpHarvester } from '../src/scrapers/europe/pbp/AcbPbpHarvester.mjs';
import { LnbPbpHarvester } from '../src/scrapers/europe/pbp/LnbPbpHarvester.mjs';
import { LbaPbpHarvester } from '../src/scrapers/europe/pbp/LbaPbpHarvester.mjs';
import { GblPbpHarvester } from '../src/scrapers/europe/pbp/GblPbpHarvester.mjs';
import { BblPbpHarvester } from '../src/scrapers/europe/pbp/BblPbpHarvester.mjs';
import { AbaPbpHarvester } from '../src/scrapers/europe/pbp/AbaPbpHarvester.mjs';
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
import {
	parseLbaClock,
	normalizeLbaAction,
	transformLbaPbp
} from '../src/scrapers/europe/pbp/LbaPbpTransformer.mjs';
import {
	parseGblClock,
	normalizeGblAction,
	transformGblPbp
} from '../src/scrapers/europe/pbp/GblPbpTransformer.mjs';
import {
	parseBblClock,
	normalizeBblAction,
	transformBblPbp
} from '../src/scrapers/europe/pbp/BblPbpTransformer.mjs';
import {
	parseAbaClock,
	normalizeAbaAction,
	transformAbaPbp
} from '../src/scrapers/europe/pbp/AbaPbpTransformer.mjs';
import { BaseNormalizer } from '#utils';
import { extractStage } from '../src/stages/1-extract.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';
import { AuditEngine } from '../src/audit/AuditEngine.mjs';

process.env.NODE_ENV = 'test';

const league = 'europe_pbp_test';
const year = '2024';

const testRawDir = path.resolve(`data/raw/${league}/pbp/${year}`);
const testTransformedDir = path.resolve(`data/transformed/${league}/pbp/${year}`);
const testDbPath = path.resolve(`data/SQL/${league.toUpperCase()}.sqlite`);

test.before(async () => {
	await fs.rm(testRawDir, { recursive: true, force: true });
	await fs.rm(testTransformedDir, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });
});

test.after(async () => {
	await fs.rm(testRawDir, { recursive: true, force: true });
	await fs.rm(testTransformedDir, { recursive: true, force: true });
	await fs.rm(testDbPath, { force: true });
});

test('EuroLeague, ACB, LNB, LBA, GBL, BBL & ABA PBP Clock and Helper Unit Tests', async (t) => {
	await t.test('parseEuroClock, parseAcbClock, parseLnbClock, parseLbaClock, parseGblClock, parseBblClock and parseAbaClock should parse clock string MM:SS into remaining period seconds', () => {
		assert.equal(parseEuroClock(null, '10:00'), 600);
		assert.equal(parseEuroClock(null, '08:45'), 525);
		assert.equal(parseEuroClock(null, '00:00'), 0);

		assert.equal(parseAcbClock('10:00'), 600);
		assert.equal(parseAcbClock('09:45'), 585);
		assert.equal(parseAcbClock('00:00'), 0);

		assert.equal(parseLnbClock('10:00'), 600);
		assert.equal(parseLnbClock('09:45'), 585);
		assert.equal(parseLnbClock('00:00'), 0);

		assert.equal(parseLbaClock('10:00'), 600);
		assert.equal(parseLbaClock('09:45'), 585);
		assert.equal(parseLbaClock('00:00'), 0);

		assert.equal(parseGblClock('10:00'), 600);
		assert.equal(parseGblClock('09:45'), 585);
		assert.equal(parseGblClock('00:00'), 0);

		assert.equal(parseBblClock('00:10:00'), 600);
		assert.equal(parseBblClock('00:09:45'), 585);
		assert.equal(parseBblClock('09:45'), 585);
		assert.equal(parseBblClock('00:00'), 0);

		assert.equal(parseAbaClock('00:10:00'), 600);
		assert.equal(parseAbaClock('00:09:45'), 585);
		assert.equal(parseAbaClock('09:45'), 585);
		assert.equal(parseAbaClock('00:00'), 0);
	});

	await t.test('normalizeAbaAction should map English and Serbo-Croatian event descriptions to standard event codes', () => {
		assert.equal(normalizeAbaAction('Filip Rebraca 3pt made'), '3FGM');
		assert.equal(normalizeAbaAction('Trojka pogođena'), '3FGM');
		assert.equal(normalizeAbaAction('3pt miss'), '3FGA');
		assert.equal(normalizeAbaAction('Trojka promašena'), '3FGA');
		assert.equal(normalizeAbaAction('2pt made'), '2FGM');
		assert.equal(normalizeAbaAction('Dvojka pogođena'), '2FGM');
		assert.equal(normalizeAbaAction('Zakucavanje'), '2FGM');
		assert.equal(normalizeAbaAction('Free throw made'), 'FTM');
		assert.equal(normalizeAbaAction('Slobodno bacanje pogođeno'), 'FTM');
		assert.equal(normalizeAbaAction('Offensive rebound'), 'ORB');
		assert.equal(normalizeAbaAction('Skok u napadu'), 'ORB');
		assert.equal(normalizeAbaAction('Defensive rebound'), 'DRB');
		assert.equal(normalizeAbaAction('Skok u odbrani'), 'DRB');
		assert.equal(normalizeAbaAction('Turnover'), 'TOV');
		assert.equal(normalizeAbaAction('Izgubljena lopta'), 'TOV');
		assert.equal(normalizeAbaAction('Steal'), 'STL');
		assert.equal(normalizeAbaAction('Osvojena lopta'), 'STL');
		assert.equal(normalizeAbaAction('Personal foul'), 'FOUL');
		assert.equal(normalizeAbaAction('Lična greška'), 'FOUL');
		assert.equal(normalizeAbaAction('Block'), 'BLK');
		assert.equal(normalizeAbaAction('Blokada'), 'BLK');
		assert.equal(normalizeAbaAction('Substitution in'), 'SUB');
		assert.equal(normalizeAbaAction('Izmena'), 'SUB');
	});

	await t.test('normalizeBblAction should map BBL action types, success flags, qualifiers, and German descriptions to standard event codes', () => {
		assert.equal(normalizeBblAction('THREE_POINT_THROW', true), '3FGM');
		assert.equal(normalizeBblAction('THREE_POINT_THROW', false), '3FGA');
		assert.equal(normalizeBblAction('TWO_POINT_THROW', true), '2FGM');
		assert.equal(normalizeBblAction('TWO_POINT_THROW', false), '2FGA');
		assert.equal(normalizeBblAction('FREE_THROW', true), 'FTM');
		assert.equal(normalizeBblAction('FREE_THROW', false), 'FTA');
		assert.equal(normalizeBblAction('REBOUND', false, ['OFFENSIVE']), 'ORB');
		assert.equal(normalizeBblAction('REBOUND', false, ['DEFENSIVE']), 'DRB');
		assert.equal(normalizeBblAction('TURN_OVER'), 'TOV');
		assert.equal(normalizeBblAction('STEAL'), 'STL');
		assert.equal(normalizeBblAction('FOUL'), 'FOUL');
		assert.equal(normalizeBblAction('BLOCK'), 'BLK');
		assert.equal(normalizeBblAction('SUBSTITUTION'), 'SUB');
		assert.equal(normalizeBblAction('OTHER', false, [], 'Dreier getroffen'), '3FGM');
		assert.equal(normalizeBblAction('OTHER', false, [], 'Korbleger erfolgreich'), '2FGM');
		assert.equal(normalizeBblAction('OTHER', false, [], 'Offensiv-Rebound'), 'ORB');
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

	await t.test('normalizeLbaAction should map Italian event descriptions to standard event codes', () => {
		assert.equal(normalizeLbaAction('Tiro da 3 punti realizzato'), '3FGM');
		assert.equal(normalizeLbaAction('Tiro da 3 punti sbagliato'), '3FGA');
		assert.equal(normalizeLbaAction('Canestro da 2 punti'), '2FGM');
		assert.equal(normalizeLbaAction('Tiro libero realizzato'), 'FTM');
		assert.equal(normalizeLbaAction('Rimbalzo offensivo'), 'ORB');
		assert.equal(normalizeLbaAction('Rimbalzo difensivo'), 'DRB');
		assert.equal(normalizeLbaAction('Palla persa'), 'TOV');
		assert.equal(normalizeLbaAction('Fallo commesso'), 'FOUL');
		assert.equal(normalizeLbaAction('Stoppata data'), 'BLK');
		assert.equal(normalizeLbaAction('Ingresso'), 'SUB');
	});

	await t.test('normalizeGblAction should map English and Greek ESAKE event descriptions to standard event codes', () => {
		assert.equal(normalizeGblAction('(25) Alec PETERS performed a 3 points jump shot'), '3FGM');
		assert.equal(normalizeGblAction('Alec PETERS missed a 3 points jump shot'), '3FGA');
		assert.equal(normalizeGblAction('performed a 2 points lay-up'), '2FGM');
		assert.equal(normalizeGblAction('missed a 2 points jump shot'), '2FGA');
		assert.equal(normalizeGblAction('made a free throw'), 'FTM');
		assert.equal(normalizeGblAction('missed a free throw'), 'FTA');
		assert.equal(normalizeGblAction('offensive rebound'), 'ORB');
		assert.equal(normalizeGblAction('defensive rebound'), 'DRB');
		assert.equal(normalizeGblAction('bad pass / turnover'), 'TOV');
		assert.equal(normalizeGblAction('commited a personal foul'), 'FOUL');
		assert.equal(normalizeGblAction('blocked shot'), 'BLK');
		assert.equal(normalizeGblAction('entered the court'), 'SUB');
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

test('PBP Cache Invalidation for Empty Skeleton Objects', async (t) => {
	await t.test('BaseNormalizer.isNonEmptyPbpPayload should identify empty vs non-empty PBP payloads', () => {
		const empty1 = { actions: [] };
		const empty2 = { jugadas: [] };
		const empty3 = { events: [] };
		const empty4 = { pbp: { Rows: [] } };
		const empty5 = { pbp: { actions: [] } };

		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(empty1), false);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(empty2), false);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(empty3), false);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(empty4), false);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(empty5), false);

		const valid1 = { actions: [{ actionNumber: 1 }] };
		const valid2 = { jugadas: [{ id: 1 }] };
		const valid3 = { events: [{ raw_index: 0 }] };
		const valid4 = { pbp: { Rows: [{ NUMBEROFPLAY: 1 }] } };

		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(valid1), true);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(valid2), true);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(valid3), true);
		assert.equal(BaseNormalizer.isNonEmptyPbpPayload(valid4), true);
	});
});

test('Adriatic ABA PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('AbaPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new AbaPbpHarvester();
		assert.deepEqual(harvester.parseGameId('partizan-vs-crvena-zvezda-V2024_123'), {
			competitionId: 'ABA2024',
			seasonCode: 'ABA2024',
			gameCode: '123',
			seasonYear: '2024'
		});
		assert.deepEqual(harvester.parseGameId('V2026_124', '2026'), {
			competitionId: 'ABA2026',
			seasonCode: 'ABA2026',
			gameCode: '124',
			seasonYear: '2026'
		});
	});

	await t.test('transformAbaPbp should normalize Serbo-Croatian/English ABA event stream and generate 5-on-5 stints', () => {
		const rawPayload = {
			seasonYear: '2024',
			competitionId: 'ABA2024',
			actions: [
				{
					actionNumber: 1,
					period: 1,
					time: "09:45",
					gt: "09:45",
					actionType: "2FGM",
					text: "Filip Rebraca dvojka pogođena",
					team: "CRVE",
					tno: "CRVE",
					personId: "filip-rebraca",
					s1: 2,
					s2: 0,
					scoring: 1
				},
				{
					actionNumber: 2,
					period: 1,
					time: "09:30",
					gt: "09:30",
					actionType: "SUB",
					text: "Antonio Sikiric izmena ulazi",
					team: "PART",
					tno: "PART",
					personId: "antonio-sikiric",
					s1: 2,
					s2: 0,
					scoring: 0
				}
			]
		};

		const { events, stints } = transformAbaPbp('V2024_123', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].competition_id, 'ABA2024');
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});
});

test('German BBL PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('BblPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new BblPbpHarvester();
		assert.deepEqual(harvester.parseGameId('fc-bayern-vs-alba-berlin-D2024_48210'), {
			competitionId: 'BBL2024',
			seasonCode: 'BBL2024',
			gameCode: '48210',
			seasonYear: '2024'
		});
		assert.deepEqual(harvester.parseGameId('D2026_48211', '2026'), {
			competitionId: 'BBL2026',
			seasonCode: 'BBL2026',
			gameCode: '48211',
			seasonYear: '2026'
		});
	});

	await t.test('transformBblPbp should normalize German BBL event stream and generate 5-on-5 stints', () => {
		const rawPayload = {
			seasonYear: '2024',
			competitionId: 'BBL2024',
			actions: [
				{
					id: 101,
					period: 1,
					gameTime: "00:09:45",
					type: "TWO_POINT_THROW",
					isSuccessful: true,
					seasonTeamId: "BAY",
					seasonPlayerId: "nick-weiler-babb",
					homeTeamPoints: 2,
					guestTeamPoints: 0,
					coordinates: { x: 12.5, y: 15.0 },
					qualifiers: ["JUMP_SHOT"]
				},
				{
					id: 102,
					period: 1,
					gameTime: "00:09:30",
					type: "SUBSTITUTION",
					isSuccessful: false,
					seasonTeamId: "ALB",
					seasonPlayerId: "louis-olinde",
					assistingSeasonPlayerId: "malte-delow",
					homeTeamPoints: 2,
					guestTeamPoints: 0,
					qualifiers: []
				}
			]
		};

		const { events, stints } = transformBblPbp('D2024_48210', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].competition_id, 'BBL2024');
		assert.equal(events[0].loc_x, 12.5);
		assert.equal(events[0].loc_y, 15.0);
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});
});

test('Greek GBL PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('GblPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new GblPbpHarvester();
		assert.deepEqual(harvester.parseGameId('olympiacos-vs-panathinaikos-G2024_65708E5D'), {
			competitionId: 'GBL2024',
			seasonCode: 'GBL2024',
			gameCode: '65708E5D',
			seasonYear: '2024'
		});
		assert.deepEqual(harvester.parseGameId('G2026_65708E5D', '2026'), {
			competitionId: 'GBL2026',
			seasonCode: 'GBL2026',
			gameCode: '65708E5D',
			seasonYear: '2026'
		});
	});

	await t.test('transformGblPbp should normalize Greek GBL event stream and generate 5-on-5 stints', () => {
		const rawPayload = {
			seasonYear: '2024',
			competitionId: 'GBL2024',
			events: [
				{
					raw_index: 0,
					clock: "09:45",
					period: 1,
					score_line: "2 - 0",
					description: "(25) Alec PETERS performed a 2 points lay-up",
					team_code: "OLY",
					player_name: "Alec PETERS"
				},
				{
					raw_index: 1,
					clock: "09:30",
					period: 1,
					score_line: "2 - 0",
					description: "(6) Cendi OSMAN entered the court",
					team_code: "PAN",
					player_name: "Cendi OSMAN"
				}
			]
		};

		const { events, stints } = transformGblPbp('G2024_65708E5D', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].competition_id, 'GBL2024');
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});
});

test('Italian LBA PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('LbaPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new LbaPbpHarvester();
		assert.deepEqual(harvester.parseGameId('unahotels-reggio-emilia-vs-dolomiti-energia-trentino-I2024_24662'), {
			competitionId: 'LBA2024',
			seasonCode: 'LBA2024',
			gameCode: '24662',
			seasonYear: '2024'
		});
		assert.deepEqual(harvester.parseGameId('I2025_24663', '2025'), {
			competitionId: 'LBA2025',
			seasonCode: 'LBA2025',
			gameCode: '24663',
			seasonYear: '2025'
		});
	});

	await t.test('transformLbaPbp should normalize Italian LBA event stream and generate 5-on-5 stints', () => {
		const rawPayload = {
			seasonYear: '2024',
			competitionId: 'LBA2024',
			pbp: {
				ht_id: 1652,
				vt_id: 1655,
				actions: [
					{
						action_id: 1,
						description: "Canestro da 2 punti",
						player_id: 7011,
						team_id: 1652,
						minute: 9,
						seconds: 45,
						period: 1,
						print_time: "09:45",
						score: "2 - 0",
						x: 12.5,
						y: 15.0
					},
					{
						action_id: 2,
						description: "Ingresso",
						player_id: 7049,
						team_id: 1655,
						minute: 9,
						seconds: 30,
						period: 1,
						print_time: "09:30",
						score: "2 - 0"
					}
				]
			}
		};

		const { events, stints } = transformLbaPbp('I2024_24662', rawPayload);
		assert.equal(events.length, 2);
		assert.equal(events[0].event_type, '2FGM');
		assert.equal(events[0].competition_id, 'LBA2024');
		assert.equal(events[0].loc_x, 12.5);
		assert.equal(events[0].loc_y, 15.0);
		assert.equal(events[0].is_scoring_play, 1);
		assert.equal(events[0].game_seconds_remaining, 2385);

		assert.equal(stints.length, 1);
		assert.equal(stints[0].period, 1);
		assert.equal(stints[0].duration_seconds, 15);
	});
});

test('French LNB PBP Harvester & Transformer Unit Tests', async (t) => {
	await t.test('LnbPbpHarvester parseGameId should parse game codes and season years', () => {
		const harvester = new LnbPbpHarvester();
		assert.deepEqual(harvester.parseGameId('L2025_1001'), {
			competitionId: 'LNB2025',
			seasonCode: 'LNB2025',
			gameCode: '1001',
			fibaMatchId: '1001',
			seasonYear: '2025'
		});
		assert.deepEqual(harvester.parseGameId('1001', '2024'), {
			competitionId: 'LNB2024',
			seasonCode: 'LNB2024',
			gameCode: '1001',
			fibaMatchId: '1001',
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

test('Europe, ACB, LNB, LBA, GBL, BBL & ABA PBP Full Pipeline Integration Test', async (t) => {
	// Setup clean mock scraper
	const scraper = new EuropeScraper({ competitions: 'acb,lnb,lba,gbl,bbl,aba,euroleague', boxscoreType: 'pbp' });
	scraper.pbpHarvester.bypassNetwork = true;
	scraper.acbPbpHarvester.bypassNetwork = true;
	scraper.lnbPbpHarvester.bypassNetwork = true;
	scraper.lbaPbpHarvester.bypassNetwork = true;
	scraper.gblPbpHarvester.bypassNetwork = true;
	scraper.bblPbpHarvester.bypassNetwork = true;
	scraper.abaPbpHarvester.bypassNetwork = true;
	scraper.getSeasonGameSlugs = async function() {
		this.gameSlugs = [
			'realmadrid-vs-panathinaikos-E2024_1',
			'barcelona-vs-valencia-A2024_105373',
			'asvel-vs-monaco-L2024_1001',
			'unahotels-reggio-emilia-vs-dolomiti-energia-trentino-I2024_24662',
			'olympiacos-vs-panathinaikos-G2024_65708E5D',
			'fc-bayern-vs-alba-berlin-D2024_48210',
			'partizan-vs-crvena-zvezda-V2024_123'
		];
		return this;
	};

	await t.test('Full Europe, ACB, LNB, LBA, GBL, BBL & ABA PBP Pipeline Execution: Extract -> Transform -> Load -> SQLite Audit', async () => {
		// Stage 1: Extract
		const extractedGameIds = await extractStage(scraper, league, year, { type: 'pbp', competitions: 'acb,lnb,lba,gbl,bbl,aba,euroleague' });
		assert.equal(extractedGameIds.length, 7);
		assert.ok(extractedGameIds.includes('E2024_1'));
		assert.ok(extractedGameIds.includes('A2024_105373'));
		assert.ok(extractedGameIds.includes('L2024_1001'));
		assert.ok(extractedGameIds.includes('I2024_24662'));
		assert.ok(extractedGameIds.includes('G2024_65708E5D'));
		assert.ok(extractedGameIds.includes('D2024_48210'));
		assert.ok(extractedGameIds.includes('V2024_123'));

		// Verify competition filtering: transform with --competition=aba should only transform ABA events
		const abaOnlyData = await transformStage(league, year, { type: 'pbp', competition: 'aba' });
		assert.equal(abaOnlyData.events.length, 2);
		assert.ok(abaOnlyData.events.every(e => e.game_id === 'V2024_123'));

		// Stage 2: Transform all competitions
		const transformedData = await transformStage(league, year, { type: 'pbp', competitions: 'acb,lnb,lba,gbl,bbl,aba,euroleague' });
		assert.ok(transformedData.events.length > 0);
		assert.ok(transformedData.stints.length > 0);

		// Stage 3: Load
		await loadStage(league, year, transformedData, { type: 'pbp', competitions: 'acb,lnb,lba,gbl,bbl,aba,euroleague' });

		// Stage 4: Direct DB verification
		let db = await initDatabase(league);
		try {
			const elEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('E2024_1');
			assert.equal(elEventsCount.count, 2);

			const acbEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('A2024_105373');
			assert.equal(acbEventsCount.count, 2);

			const lnbEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('L2024_1001');
			assert.equal(lnbEventsCount.count, 2);

			const lbaEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('I2024_24662');
			assert.equal(lbaEventsCount.count, 2);

			const gblEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('G2024_65708E5D');
			assert.equal(gblEventsCount.count, 2);

			const bblEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('D2024_48210');
			assert.equal(bblEventsCount.count, 2);

			const abaEventsCount = db.prepare('SELECT COUNT(*) as count FROM game_play_by_play WHERE game_id = ?').get('V2024_123');
			assert.equal(abaEventsCount.count, 2);

			const elStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('E2024_1');
			assert.equal(elStintsCount.count, 1);

			const acbStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('A2024_105373');
			assert.equal(acbStintsCount.count, 1);

			const lnbStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('L2024_1001');
			assert.equal(lnbStintsCount.count, 1);

			const lbaStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('I2024_24662');
			assert.equal(lbaStintsCount.count, 1);

			const gblStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('G2024_65708E5D');
			assert.equal(gblStintsCount.count, 1);

			const bblStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('D2024_48210');
			assert.equal(bblStintsCount.count, 1);

			const abaStintsCount = db.prepare('SELECT COUNT(*) as count FROM game_stints WHERE game_id = ?').get('V2024_123');
			assert.equal(abaStintsCount.count, 1);

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
			if (db) {
				db.close();
				db = null;
			}
		}
	});
});
