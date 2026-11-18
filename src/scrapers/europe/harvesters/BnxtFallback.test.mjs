import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchBnxtFibaLiveStats, mapBnxtFibaBoxScore } from './BnxtFibaLiveStats.mjs';
import { BnxtScraper } from '../BnxtScraper.mjs';
import { BnxtPbpHarvester } from '../pbp/BnxtPbpHarvester.mjs';
import { BnxtHarvester } from './BnxtHarvester.mjs';
import { parseBnxtPortalSchedule, getBnxtSeasonEndYear, mapBnxtPortalGame } from './BnxtPortalSchedule.mjs';
import { EuropeScraper } from '../europe.mjs';

test('BNXT Portal schedule parser filters the requested cross-calendar season', () => {
	const games = [
		{ date: '2026-09-26', home_team: 'Landstede Hammers', away_team: 'Windrose Giants Antwerp', external_id: 11753, genius_id: 2877801 },
		{ date: '2027-05-08', home_team: 'Heroes Den Bosch', away_team: 'Brussels Basketball', external_id: 11741, genius_id: null },
		{ date: '2027-09-25', home_team: 'Home Team', away_team: 'Away Team', external_id: 11800, genius_id: null }
	];
	const html = `<div x-data="matchFilters(${JSON.stringify(games).replaceAll('"', '&quot;')})">`;
	assert.equal(parseBnxtPortalSchedule(html).length, 3);
	assert.equal(getBnxtSeasonEndYear('2026-09-26'), 2027);
	assert.equal(getBnxtSeasonEndYear('2027-05-08'), 2027);
	assert.equal(getBnxtSeasonEndYear('2027-09-25'), 2028);
	assert.deepEqual(mapBnxtPortalGame(games[0], '2027'), {
		slug: 'landstede-hammers-vs-windrose-giants-antwerp-N2027_11753',
		gameId: '11753',
		geniusMatchId: '2877801'
	});
});

test('BnxtHarvester falls back to BNXT Portal when Sportpress rejects the season request', async () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalFetch = globalThis.fetch;
	const metadata = new Map();
	const games = [
		{ date: '2026-09-26', time: '20:30', home_team: 'Landstede Hammers', away_team: 'Windrose Giants Antwerp', external_id: 11753, genius_id: 2877801, home_score: 80, away_score: 75 },
		{ date: '2027-05-08', time: '20:30', home_team: 'Heroes Den Bosch', away_team: 'Brussels Basketball', external_id: 11741, genius_id: null }
	];
	const html = `<div x-data="matchFilters(${JSON.stringify(games).replaceAll('"', '&quot;')})">`;
	const requestedUrls = [];
	try {
		process.env.NODE_ENV = 'development';
		globalThis.fetch = async (url) => {
			requestedUrls.push(String(url));
			if (String(url).includes('bnxtportal.com')) return { ok: true, text: async () => html };
			return { ok: false, status: 401, statusText: 'Unauthorized' };
		};
		const harvester = new BnxtHarvester({ setGameMetadata: (id, value) => metadata.set(id, value) });
		const slugs = await harvester.getSeasonGameSlugs('2027');
		assert.deepEqual(slugs, [
			'landstede-hammers-vs-windrose-giants-antwerp-N2027_11753',
			'heroes-den-bosch-vs-brussels-basketball-N2027_11741'
		]);
		assert.equal(metadata.get('11753').geniusMatchId, '2877801');
		assert.equal(metadata.get('11753').gameData.competitors[0].finalScore, 80);
		assert.ok(requestedUrls.some(url => url.includes('bnxtportal.com/wedstrijden')));
	} finally {
		globalThis.fetch = originalFetch;
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
	}
});

test('BnxtHarvester enriches successful Sportpress schedules with Genius IDs', async () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalFetch = globalThis.fetch;
	const metadata = new Map();
	const portalGames = [{
		date: '2026-10-02', time: '20:30', home_team: 'House of Talents Spurs Kortrijk',
		away_team: 'Donar Groningen', external_id: 11271, genius_id: 2873603
	}];
	const portalHtml = `<div x-data="matchFilters(${JSON.stringify(portalGames).replaceAll('"', '&quot;')})">`;
	try {
		process.env.NODE_ENV = 'development';
		globalThis.fetch = async (url) => {
			const requestUrl = String(url);
			if (requestUrl.includes('/phase/season/')) {
				return { ok: true, json: async () => ({ data: [{ competition: { id: 25 } }] }) };
			}
			if (requestUrl.includes('/competition-team/all')) {
				return { ok: true, json: async () => ({ data: [{ id: 1 }] }) };
			}
			if (requestUrl.includes('/statistics-by-game/total/')) {
				return { ok: true, json: async () => ({ data: [{
					id: 11271,
					competitors: [
						{ side: 1, competition_team: { name: 'House of Talents Spurs Kortrijk' } },
						{ side: 2, competition_team: { name: 'Donar Groningen' } }
					]
				}] }) };
			}
			if (requestUrl.includes('bnxtportal.com/wedstrijden')) {
				return { ok: true, text: async () => portalHtml };
			}
			throw new Error(`Unexpected URL ${requestUrl}`);
		};
		const harvester = new BnxtHarvester({ setGameMetadata: (id, value) => metadata.set(id, value) });
		const slugs = await harvester.getSeasonGameSlugs('2027');
		assert.equal(slugs.length, 1);
		assert.equal(metadata.get('11271').geniusMatchId, 2873603);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
	}
});

test('EuropeScraper forwards harvested Genius IDs to BNXT PBP fetching', async () => {
	const scraper = new EuropeScraper({ competitions: 'bnxt' });
	scraper.engines.bnxt.setGameMetadata('11271', { geniusMatchId: 2873603, gameData: {} });
	let receivedArgs;
	scraper.bnxtPbpHarvester.fetchBnxtPbp = async (...args) => {
		receivedArgs = args;
		return { source: 'test' };
	};

	const payload = await scraper.fetchPbp('N2027_11271', '2027');
	assert.deepEqual(receivedArgs, ['N2027_11271', '2027', 2873603]);
	assert.equal(payload.source, 'test');
});

test('fetchBnxtFibaLiveStats accepts a FIBA game payload and rejects HTTP errors', async () => {
	const feed = { tm: { '1': {}, '2': {} }, pbp: [] };
	const fetchImpl = async (url) => {
		assert.equal(url, 'https://fibalivestats.dcd.shared.geniussports.com/data/2143742/data.json');
		return { ok: true, json: async () => feed };
	};
	assert.equal(await fetchBnxtFibaLiveStats('2143742', fetchImpl), feed);
	await assert.rejects(
		fetchBnxtFibaLiveStats('2143742', async () => ({ ok: false, status: 404 })),
		/HTTP 404/
	);
});

test('mapBnxtFibaBoxScore maps team totals, players, and advanced stats', () => {
	const mapped = mapBnxtFibaBoxScore({
		period: 4,
		periodLength: 10,
		tm: {
			'1': {
				name: 'Home Club', code: 'HOM', score: 83,
				tot_sPoints: 83, tot_sFieldGoalsMade: 30, tot_sPointsSecondChance: 12,
				pl: { '7': {
					firstName: 'Alex', familyName: 'Player', shirtNumber: '7', sMinutes: '22:10',
					sPoints: 14, sFieldGoalsMade: 5, sFieldGoalsAttempted: 11,
					sReboundsTotal: 6, sPlusMinusPoints: 4, sPointsInThePaint: 8, eff_1: 15
				} }
			},
			'2': { name: 'Away Club', code: 'AWY', score: 79, pl: {} }
		}
	}, {
		gameId: 'home-vs-away-N2026_7161', competitionId: 'bnxt', seasonYear: '2026', matchId: '2143742'
	});

	assert.equal(mapped.source, 'fiba_livestats');
	assert.equal(mapped.homeTeam.score, 83);
	assert.equal(mapped.homeTeam.statistics.fgm, 30);
	assert.equal(mapped.homeTeam.advancedStats.pointsSecondChance, 12);
	assert.equal(mapped.homeTeam.players[0].playerName, 'Alex Player');
	assert.equal(mapped.homeTeam.players[0].statistics.min, '22:10');
	assert.equal(mapped.homeTeam.players[0].advancedStats.efficiency, 15);
	assert.equal(mapped.awayTeam.teamId, 'AWY');
	assert.equal(mapBnxtFibaBoxScore({ tm: { '1': {} } }, {
		gameId: 'g', competitionId: 'bnxt', seasonYear: '2026', matchId: '1'
	}), null);
});

test('BnxtScraper falls back to FIBA LiveStats after BNXT API errors', async () => {
	const originalCwd = process.cwd();
	const originalNodeEnv = process.env.NODE_ENV;
	const originalFetch = globalThis.fetch;
	const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bnxt-fiba-fallback-'));
	const requestedUrls = [];
	const fibaData = {
		tm: {
			'1': { name: 'Home', code: 'HOM', score: 81, pl: {} },
			'2': { name: 'Away', code: 'AWY', score: 76, pl: {} }
		},
		pbp: []
	};

	try {
		process.chdir(tempDirectory);
		process.env.NODE_ENV = 'development';
		globalThis.fetch = async (url) => {
			requestedUrls.push(String(url));
			if (String(url).includes('/data/2143742/data.json')) {
				return { ok: true, json: async () => fibaData };
			}
			return { ok: false, status: 401, statusText: 'Unauthorized' };
		};

		const scraper = new BnxtScraper();
		scraper.setGameMetadata('7161', { geniusMatchId: '2143742' });
		const boxScore = await scraper.getUnifiedBoxScore('home-vs-away-N2026_7161');

		assert.equal(boxScore.source, 'fiba_livestats');
		assert.equal(boxScore.homeTeam.score, 81);
		assert.equal(boxScore.awayTeam.score, 76);
		assert.ok(requestedUrls.some(url => url.includes('/data/2143742/data.json')));
	} finally {
		globalThis.fetch = originalFetch;
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		process.chdir(originalCwd);
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});

test('BnxtPbpHarvester uses an available Genius ID when BNXT metadata lookup fails', async () => {
	const originalCwd = process.cwd();
	const originalNodeEnv = process.env.NODE_ENV;
	const originalFetch = globalThis.fetch;
	const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bnxt-fiba-pbp-'));
	const requestedUrls = [];
	const fibaData = {
		tm: { '1': { name: 'Home' }, '2': { name: 'Away' } },
		pbp: [{ actionNumber: 1, period: 1, gt: '00:09:45', tno: 1, actionType: '3pt', success: 1 }]
	};

	try {
		process.chdir(tempDirectory);
		process.env.NODE_ENV = 'development';
		globalThis.fetch = async (url) => {
			requestedUrls.push(String(url));
			if (String(url).includes('/data/2143742/data.json')) {
				return { ok: true, json: async () => fibaData };
			}
			return { ok: false, status: 401, statusText: 'Unauthorized' };
		};

		const harvester = new BnxtPbpHarvester({ bypassNetwork: false });
		const payload = await harvester.fetchBnxtPbp('home-vs-away-N2026_7161', '2026', '2143742');
		assert.equal(payload.source, 'fiba_livestats');
		assert.equal(payload.geniusId, '2143742');
		assert.equal(payload.data.pbp.length, 1);
		assert.ok(requestedUrls.some(url => url.includes('/data/2143742/data.json')));
	} finally {
		globalThis.fetch = originalFetch;
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		process.chdir(originalCwd);
		await fs.rm(tempDirectory, { recursive: true, force: true });
	}
});
