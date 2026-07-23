import test from 'node:test';
import assert from 'node:assert/strict';
import { EuropeScraper } from '../src/scrapers/europe/europe.mjs';
import { FibaLiveStatsEngine } from '../src/scrapers/europe/engines/FibaLiveStatsEngine.mjs';
import { SsrHydrationEngine } from '../src/scrapers/europe/engines/SsrHydrationEngine.mjs';
import { DomesticRestEngine } from '../src/scrapers/europe/engines/DomesticRestEngine.mjs';

test.describe('European Domestic Leagues Integration', () => {
	test.beforeEach(() => {
		process.env.NODE_ENV = 'test';
	});

	test('should successfully resolve engine for given domestic game prefixes in EuropeScraper', () => {
		const scraper = new EuropeScraper({ competitions: 'all' });

		// FibaLiveStatsEngine targets: ABA, LKL, GBL
		const abaEngine = scraper.getEngineForGame('matchup-ABA25_1001');
		assert.ok(abaEngine instanceof FibaLiveStatsEngine, 'Should resolve ABA game to FibaLiveStatsEngine');

		const lklEngine = scraper.getEngineForGame('matchup-LKL25_1002');
		assert.ok(lklEngine instanceof FibaLiveStatsEngine, 'Should resolve LKL game to FibaLiveStatsEngine');

		const gblEngine = scraper.getEngineForGame('matchup-GBL25_1003');
		assert.ok(gblEngine instanceof FibaLiveStatsEngine, 'Should resolve GBL game to FibaLiveStatsEngine');

		// SsrHydrationEngine targets: ACB, LBA, LNB
		const acbEngine = scraper.getEngineForGame('matchup-ACB25_2001');
		assert.ok(acbEngine instanceof SsrHydrationEngine, 'Should resolve ACB game to SsrHydrationEngine');

		const lbaEngine = scraper.getEngineForGame('matchup-LBA25_2002');
		assert.ok(lbaEngine instanceof SsrHydrationEngine, 'Should resolve LBA game to SsrHydrationEngine');

		const lnbEngine = scraper.getEngineForGame('matchup-LNB25_2003');
		assert.ok(lnbEngine instanceof SsrHydrationEngine, 'Should resolve LNB game to SsrHydrationEngine');

		// DomesticRestEngine targets: BBL, BSL, ISRAEL
		const bblEngine = scraper.getEngineForGame('matchup-BBL25_3001');
		assert.ok(bblEngine instanceof DomesticRestEngine, 'Should resolve BBL game to DomesticRestEngine');

		const bslEngine = scraper.getEngineForGame('matchup-BSL25_3002');
		assert.ok(bslEngine instanceof DomesticRestEngine, 'Should resolve BSL game to DomesticRestEngine');

		const israelEngine = scraper.getEngineForGame('matchup-ISRAEL25_3003');
		assert.ok(israelEngine instanceof DomesticRestEngine, 'Should resolve ISRAEL game to DomesticRestEngine');
	});

	test('FibaLiveStatsEngine should fetch unified mock game data and format properly', async () => {
		const engine = new FibaLiveStatsEngine();
		const result = await engine.getUnifiedBoxScore('matchup-ABA25_1001');

		assert.equal(result.competitionId, 'aba');
		assert.equal(result.seasonId, '2025');
		assert.equal(result.homeTeam.teamName, 'KK Partizan');
		assert.equal(result.awayTeam.teamName, 'KK Crvena Zvezda');
		assert.equal(result.homeTeam.score, 90);
		assert.equal(result.awayTeam.score, 82);
		assert.equal(result.homeTeam.players[0].playerName, 'Carlik Jones');
		assert.equal(result.homeTeam.players[0].statistics.pts, 18);
	});

	test('SsrHydrationEngine should fetch unified mock game data and format properly', async () => {
		const engine = new SsrHydrationEngine();
		const result = await engine.getUnifiedBoxScore('matchup-ACB25_2001');

		assert.equal(result.competitionId, 'acb');
		assert.equal(result.seasonId, '2025');
		assert.equal(result.homeTeam.teamName, 'FC Barcelona');
		assert.equal(result.awayTeam.teamName, 'Real Madrid Baloncesto');
		assert.equal(result.homeTeam.score, 95);
		assert.equal(result.awayTeam.score, 88);
		assert.equal(result.homeTeam.players[0].playerName, 'Tomas Satoransky');
		assert.equal(result.homeTeam.players[0].statistics.pts, 11);
	});

	test('DomesticRestEngine should fetch unified mock game data and format properly', async () => {
		const engine = new DomesticRestEngine();
		const result = await engine.getUnifiedBoxScore('matchup-BBL25_3001');

		assert.equal(result.competitionId, 'bbl');
		assert.equal(result.seasonId, '2025');
		assert.equal(result.homeTeam.teamName, 'ALBA Berlin');
		assert.equal(result.awayTeam.teamName, 'FC Bayern Munich');
		assert.equal(result.homeTeam.score, 87);
		assert.equal(result.awayTeam.score, 78);
		assert.equal(result.homeTeam.players[0].playerName, 'Louis Olinde');
		assert.equal(result.homeTeam.players[0].statistics.pts, 14);
	});
});
