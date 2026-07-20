import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { HTTPClient, validateSchema } from '#utils';
import { WNBAScraper } from '../src/scrapers/wnba/wnba.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

const mockLeagueGameLogResponse = {
	resource: "leaguegamelog",
	parameters: {
		LeagueID: "10",
		Season: "2023"
	},
	resultSets: [
		{
			name: "LeagueGameLog",
			headers: ["GAME_ID", "MATCHUP"],
			rowSet: [
				["0042300101", "NYL @ CON"],
				["0042300101", "CON vs NYL"],
				["0042300102", "LAS @ MIN"]
			]
		}
	]
};

const mockBoxScoreResponse = {
	resource: "boxscore",
	parameters: {
		GameID: "0042300101"
	},
	resultSets: [
		{
			name: "PlayerStats",
			headers: ["GAME_ID", "PLAYER_NAME", "PTS"],
			rowSet: [
				["0042300101", "Sabrina Ionescu", 15],
				["0042300101", "Breanna Stewart", 24]
			]
		},
		{
			name: "TeamStats",
			headers: ["GAME_ID", "TEAM_NAME", "PTS"],
			rowSet: [
				["0042300101", "New York Liberty", 95],
				["0042300101", "Connecticut Sun", 82]
			]
		}
	]
};

// Global fetch mocking helper
let fetchMock = null;
const originalFetch = globalThis.fetch;

test.before(() => {
	globalThis.fetch = async (url, config) => {
		if (fetchMock) {
			return fetchMock(url, config);
		}
		return originalFetch(url, config);
	};
});

test.after(() => {
	globalThis.fetch = originalFetch;
});

test.beforeEach(() => {
	fetchMock = null;
});

test.describe('HTTPClient', () => {
	test('should make a successful request and parse JSON', async () => {
		const client = new HTTPClient('http://test.api');
		fetchMock = async (url, config) => {
			assert.equal(url, 'http://test.api/data');
			return {
				ok: true,
				status: 200,
				json: async () => ({ success: true })
			};
		};

		const response = await client.request('/data');
		assert.deepEqual(response, { success: true });
	});

	test('should retry on HTTP 429/500 with exponential backoff and eventually succeed', async () => {
		const client = new HTTPClient('http://test.api');
		let attempts = 0;

		fetchMock = async (url, config) => {
			attempts++;
			if (attempts < 3) {
				return {
					ok: false,
					status: 429,
					statusText: 'Too Many Requests',
					json: async () => ({})
				};
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ attempts })
			};
		};

		const response = await client.request('/retry', {}, 3, 10);
		assert.equal(attempts, 3);
		assert.deepEqual(response, { attempts: 3 });
	});

	test('should throw an error when all retries are exhausted', async () => {
		const client = new HTTPClient('http://test.api');
		let attempts = 0;

		fetchMock = async (url, config) => {
			attempts++;
			return {
				ok: false,
				status: 500,
				statusText: 'Internal Server Error'
			};
		};

		await assert.rejects(
			async () => {
				await client.request('/error', {}, 2, 5);
			},
			/HTTP Error: 500 Internal Server Error/
		);
		assert.equal(attempts, 3); // 1 initial attempt + 2 retries
	});

	test('should retry on network/fetch errors', async () => {
		const client = new HTTPClient('http://test.api');
		let attempts = 0;

		fetchMock = async (url, config) => {
			attempts++;
			if (attempts < 2) {
				throw new TypeError('Failed to fetch');
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ success: true })
			};
		};

		const response = await client.request('/network', {}, 2, 5);
		assert.equal(attempts, 2);
		assert.deepEqual(response, { success: true });
	});
});

test.describe('Schema Validator', () => {
	test('should successfully validate leaguegamelog schema', () => {
		const valid = validateSchema('wnba/leaguegamelog.json', mockLeagueGameLogResponse);
		assert.equal(valid, true);
	});

	test('should throw on invalid leaguegamelog schema', () => {
		const invalidResponse = { ...mockLeagueGameLogResponse, resultSets: null };
		assert.throws(
			() => validateSchema('wnba/leaguegamelog.json', invalidResponse),
			/JSON Schema Validation Error for schema wnba\/leaguegamelog.json/
		);
	});

	test('should successfully validate boxscore schema', () => {
		const valid = validateSchema('wnba/boxscore.json', mockBoxScoreResponse);
		assert.equal(valid, true);
	});

	test('should throw on invalid boxscore schema', () => {
		const invalidResponse = { ...mockBoxScoreResponse, resultSets: [{ name: "PlayerStats" }] }; // missing headers and rowSet
		assert.throws(
			() => validateSchema('wnba/boxscore.json', invalidResponse),
			/JSON Schema Validation Error for schema wnba\/boxscore.json/
		);
	});
});

test.describe('WNBAScraper', () => {
	test('getSeasonGameSlugs should fetch and map game slugs', async () => {
		const scraper = new WNBAScraper();

		fetchMock = async (url, config) => {
			assert.match(url, /\/leaguegamelog\?/);
			return {
				ok: true,
				status: 200,
				json: async () => mockLeagueGameLogResponse
			};
		};

		const result = await scraper.getSeasonGameSlugs('2023');
		assert.equal(result, scraper);
		assert.deepEqual(scraper.gameSlugs, [
			'nyl-vs-con-0042300101',
			'convsnyl-0042300101',
			'las-vs-min-0042300102'
		]);
	});

	test('getAPIBoxScore should fetch, validate and map box score statistics', async () => {
		const scraper = new WNBAScraper();

		fetchMock = async (url, config) => {
			assert.match(url, /\/boxscoretraditionalv2\?/);
			return {
				ok: true,
				status: 200,
				json: async () => mockBoxScoreResponse
			};
		};

		const data = await scraper.getAPIBoxScore('0042300101', 'traditional');
		assert.equal(data.players.length, 2);
		assert.equal(data.teams.length, 2);

		assert.deepEqual(data.players[0], {
			GAME_ID: '0042300101',
			PLAYER_NAME: 'Sabrina Ionescu',
			PTS: 15
		});
		assert.deepEqual(data.teams[0], {
			GAME_ID: '0042300101',
			TEAM_NAME: 'New York Liberty',
			PTS: 95
		});
	});

	test('scrapeAndSaveBoxScore should fetch, validate, map and write mapped data to file', async () => {
		const scraper = new WNBAScraper();
		const tempDir = path.join(PROJECT_ROOT, 'data/JSON/WNBA_test_temp');

		fetchMock = async (url, config) => {
			return {
				ok: true,
				status: 200,
				json: async () => mockBoxScoreResponse
			};
		};

		try {
			// Ensure clean starting state
			await fs.rm(tempDir, { recursive: true, force: true });

			const savedData = await scraper.scrapeAndSaveBoxScore('0042300101', 'traditional', tempDir);
			assert.equal(savedData.players.length, 2);

			const expectedFilePath = path.join(tempDir, 'boxscore_0042300101_traditional.json');
			const fileExists = await fs.access(expectedFilePath).then(() => true).catch(() => false);
			assert.equal(fileExists, true);

			const fileContent = await fs.readFile(expectedFilePath, 'utf8');
			const parsedData = JSON.parse(fileContent);

			assert.deepEqual(parsedData, savedData);
		} finally {
			// Cleanup temp dir
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('getGameEndpoint should return the correct endpoint path', () => {
		const scraper = new WNBAScraper();
		const endpoint = scraper.getGameEndpoint('0042300101');
		assert.equal(endpoint, '/boxscoretraditionalv2');
	});

	test('getGameUrl should return the correct URL including the game ID', () => {
		const scraper = new WNBAScraper();
		const url = scraper.getGameUrl('0042300101');
		assert.match(url, /\/boxscoretraditionalv2/);
		assert.match(url, /GameID=0042300101/);
	});
});
