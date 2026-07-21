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
	lscd: [
		{
			mscd: {
				mon: "May",
				g: [
					{
						gid: "0042300101",
						gcode: "20230519/NYLCON",
						v: { ta: "NYL" },
						h: { ta: "CON" }
					},
					{
						gid: "0042300102",
						gcode: "20230520/LASMIN",
						v: { ta: "LAS" },
						h: { ta: "MIN" }
					}
				]
			}
		}
	]
};

const mockNextData = {
	props: {
		pageProps: {
			game: {
				gameId: "0042300101",
				homeTeam: {
					teamId: 1611661315,
					teamName: "Sun",
					teamCity: "Connecticut",
					teamTricode: "CON",
					statistics: {
						minutes: "200:00",
						points: 82,
						fieldGoalsMade: 32,
						fieldGoalsAttempted: 70,
						threePointersMade: 5,
						threePointersAttempted: 15,
						freeThrowsMade: 13,
						freeThrowsAttempted: 18,
						reboundsOffensive: 10,
						reboundsDefensive: 25,
						reboundsTotal: 35,
						assists: 18,
						steals: 8,
						blocks: 5,
						turnovers: 12,
						foulsPersonal: 15,
						plusMinusPoints: -13
					},
					players: [
						{
							personId: 10001,
							firstName: "Alyssa",
							familyName: "Thomas",
							position: "F",
							comment: "",
							statistics: {
								minutes: "35:00",
								points: 18,
								fieldGoalsMade: 7,
								fieldGoalsAttempted: 15,
								threePointersMade: 0,
								threePointersAttempted: 0,
								freeThrowsMade: 4,
								freeThrowsAttempted: 6,
								reboundsOffensive: 3,
								reboundsDefensive: 8,
								reboundsTotal: 11,
								assists: 6,
								steals: 3,
								blocks: 1,
								turnovers: 2,
								foulsPersonal: 3,
								plusMinusPoints: -10
							}
						}
					]
				},
				awayTeam: {
					teamId: 1611661313,
					teamName: "Liberty",
					teamCity: "New York",
					teamTricode: "NYL",
					statistics: {
						minutes: "200:00",
						points: 95,
						fieldGoalsMade: 36,
						fieldGoalsAttempted: 75,
						threePointersMade: 10,
						threePointersAttempted: 22,
						freeThrowsMade: 13,
						freeThrowsAttempted: 15,
						reboundsOffensive: 8,
						reboundsDefensive: 28,
						reboundsTotal: 36,
						assists: 22,
						steals: 6,
						blocks: 4,
						turnovers: 10,
						foulsPersonal: 14,
						plusMinusPoints: 13
					},
					players: [
						{
							personId: 10002,
							firstName: "Sabrina",
							familyName: "Ionescu",
							position: "G",
							comment: "",
							statistics: {
								minutes: "32:00",
								points: 15,
								fieldGoalsMade: 5,
								fieldGoalsAttempted: 10,
								threePointersMade: 3,
								threePointersAttempted: 6,
								freeThrowsMade: 2,
								freeThrowsAttempted: 2,
								reboundsOffensive: 1,
								reboundsDefensive: 4,
								reboundsTotal: 5,
								assists: 5,
								steals: 2,
								blocks: 0,
								turnovers: 1,
								foulsPersonal: 2,
								plusMinusPoints: 12
							}
						}
					]
				}
			}
		}
	}
};

const mockGameHtmlResponse = `
<html>
<head>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(mockNextData)}</script>
</head>
<body></body>
</html>
`;

const mockBoxScoreResponse = {
	resource: "boxscore",
	parameters: {
		GameID: "0042300101"
	},
	resultSets: [
		{
			name: "PlayerStats",
			headers: ["GAME_ID", "TEAM_ID", "TEAM_ABBREVIATION", "TEAM_CITY", "PLAYER_ID", "PLAYER_NAME", "START_POSITION", "COMMENT", "MIN", "FGM", "FGA", "FG_PCT", "FG3M", "FG3A", "FG3_PCT", "FTM", "FTA", "FT_PCT", "OREB", "DREB", "REB", "AST", "STL", "BLK", "TO", "PF", "PTS", "PLUS_MINUS"],
			rowSet: [
				["0042300101", 1611661315, "CON", "Connecticut", 10001, "Alyssa Thomas", "F", "", "35:00", 7, 15, 0.467, 0, 0, 0, 4, 6, 0.667, 3, 8, 11, 6, 3, 1, 2, 3, 18, -10],
				["0042300101", 1611661313, "NYL", "New York", 10002, "Sabrina Ionescu", "G", "", "32:00", 5, 10, 0.5, 3, 6, 0.5, 2, 2, 1, 1, 4, 5, 5, 2, 0, 1, 2, 15, 12]
			]
		},
		{
			name: "TeamStats",
			headers: ["GAME_ID", "TEAM_ID", "TEAM_NAME", "TEAM_ABBREVIATION", "TEAM_CITY", "MIN", "FGM", "FGA", "FG_PCT", "FG3M", "FG3A", "FG3_PCT", "FTM", "FTA", "FT_PCT", "OREB", "DREB", "REB", "AST", "STL", "BLK", "TO", "PF", "PTS", "PLUS_MINUS"],
			rowSet: [
				["0042300101", 1611661315, "Connecticut Sun", "CON", "Connecticut", "200:00", 32, 70, 0.457, 5, 15, 0.333, 13, 18, 0.722, 10, 25, 35, 18, 8, 5, 12, 15, 82, -13],
				["0042300101", 1611661313, "New York Liberty", "NYL", "New York", "200:00", 36, 75, 0.48, 10, 22, 0.455, 13, 15, 0.867, 8, 28, 36, 22, 6, 4, 10, 14, 95, 13]
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
		const invalidResponse = { ...mockLeagueGameLogResponse, lscd: null };
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
			assert.match(url, /full_schedule\.json/);
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
			'las-vs-min-0042300102'
		]);
	});

	test('getAPIBoxScore should fetch, validate and map box score statistics', async () => {
		const scraper = new WNBAScraper();

		fetchMock = async (url, config) => {
			assert.match(url, /wnba\.com\/game\//);
			return {
				ok: true,
				status: 200,
				text: async () => mockGameHtmlResponse
			};
		};

		const data = await scraper.getAPIBoxScore('0042300101', 'traditional');
		assert.equal(data.players.length, 2);
		assert.equal(data.teams.length, 2);

		assert.equal(data.players[0].PLAYER_NAME, 'Alyssa Thomas');
		assert.equal(data.players[0].PTS, 18);
		assert.equal(data.teams[1].TEAM_NAME, 'New York Liberty');
		assert.equal(data.teams[1].PTS, 95);
	});

	test('scrapeAndSaveBoxScore should fetch, validate, map and write mapped data to file', async () => {
		const scraper = new WNBAScraper();
		const tempDir = path.join(PROJECT_ROOT, 'data/JSON/WNBA_test_temp');

		fetchMock = async (url, config) => {
			return {
				ok: true,
				status: 200,
				text: async () => mockGameHtmlResponse
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
		assert.equal(url, 'https://www.wnba.com/game/0042300101');
	});

	test('getGameEndpoint with advanced scraper configuration', () => {
		const scraper = new WNBAScraper({ boxscoreType: 'advanced' });
		const endpoint = scraper.getGameEndpoint('0042300101');
		assert.equal(endpoint, '/boxscoreadvancedv2');

		const explicitTraditionalEndpoint = scraper.getGameEndpoint('0042300101', 'traditional');
		assert.equal(explicitTraditionalEndpoint, '/boxscoretraditionalv2');
	});

	test('getGameUrl with advanced scraper configuration', () => {
		const scraper = new WNBAScraper({ boxscoreType: 'advanced' });
		const url = scraper.getGameUrl('0042300101');
		assert.equal(url, 'https://www.wnba.com/game/0042300101');

		const explicitTraditionalUrl = scraper.getGameUrl('0042300101', 'traditional');
		assert.equal(explicitTraditionalUrl, 'https://www.wnba.com/game/0042300101');
	});
});
