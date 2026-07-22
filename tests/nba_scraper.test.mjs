import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { HTTPClient, validateSchema } from '#utils';
import { NBAScraper } from '../src/scrapers/nba/nba.mjs';
import { transformStage } from '../src/stages/2-transform.mjs';
import { loadStage, initDatabase } from '../src/stages/3-load.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

const mockNBALeagueGameLogResponse = {
	lscd: [
		{
			mscd: {
				mon: "October",
				g: [
					{
						gid: "0022300001",
						gcode: "20231024/LALBOS",
						v: { ta: "LAL" },
						h: { ta: "BOS" }
					},
					{
						gid: "0022300002",
						gcode: "20231024/PHXGSW",
						v: { ta: "PHX" },
						h: { ta: "GSW" }
					},
					{
						gid: "0092300001", // Invalid prefix (should be filtered out!)
						gcode: "20231024/FOOBAR",
						v: { ta: "FOO" },
						h: { ta: "BAR" }
					}
				]
			}
		}
	]
};

const mockNBANextData = {
	props: {
		pageProps: {
			game: {
				gameId: "0022300001",
				homeTeam: {
					teamId: 1610612738,
					teamName: "Celtics",
					teamCity: "Boston",
					teamTricode: "BOS",
					statistics: {
						minutes: "PT200M",
						points: 108,
						fieldGoalsMade: 40,
						fieldGoalsAttempted: 85,
						threePointersMade: 12,
						threePointersAttempted: 32,
						freeThrowsMade: 16,
						freeThrowsAttempted: 20,
						reboundsOffensive: 12,
						reboundsDefensive: 30,
						reboundsTotal: 42,
						assists: 24,
						steals: 7,
						blocks: 6,
						turnovers: 11,
						foulsPersonal: 18,
						plusMinusPoints: 5
					},
					players: [
						{
							personId: 201142,
							firstName: "Kevin",
							familyName: "Durant",
							position: "F",
							comment: "",
							statistics: {
								minutes: "PT36M12.00S", // ISO-8601 format to test parser
								points: 25,
								fieldGoalsMade: 9,
								fieldGoalsAttempted: 18,
								threePointersMade: 2,
								threePointersAttempted: 5,
								freeThrowsMade: 5,
								freeThrowsAttempted: 6,
								reboundsOffensive: 2,
								reboundsDefensive: 6,
								reboundsTotal: 8,
								assists: 4,
								steals: 1,
								blocks: 2,
								turnovers: 3,
								foulsPersonal: 3,
								plusMinusPoints: 2
							}
						}
					]
				},
				awayTeam: {
					teamId: 1610612747,
					teamName: "Lakers",
					teamCity: "Los Angeles",
					teamTricode: "LAL",
					statistics: {
						minutes: "PT200M",
						points: 103,
						fieldGoalsMade: 38,
						fieldGoalsAttempted: 88,
						threePointersMade: 10,
						threePointersAttempted: 30,
						freeThrowsMade: 17,
						freeThrowsAttempted: 22,
						reboundsOffensive: 10,
						reboundsDefensive: 28,
						reboundsTotal: 38,
						assists: 21,
						steals: 8,
						blocks: 4,
						turnovers: 13,
						foulsPersonal: 20,
						plusMinusPoints: -5
					},
					players: [
						{
							personId: 2544,
							firstName: "LeBron",
							familyName: "James",
							position: "F",
							comment: "",
							statistics: {
								minutes: "PT35M00.00S", // ISO-8601 format to test parser
								points: 21,
								fieldGoalsMade: 8,
								fieldGoalsAttempted: 16,
								threePointersMade: 1,
								threePointersAttempted: 4,
								freeThrowsMade: 4,
								freeThrowsAttempted: 6,
								reboundsOffensive: 1,
								reboundsDefensive: 7,
								reboundsTotal: 8,
								assists: 5,
								steals: 1,
								blocks: 1,
								turnovers: 4,
								foulsPersonal: 2,
								plusMinusPoints: -3
							}
						}
					]
				}
			}
		}
	}
};

const mockNBAGameHtmlResponse = `
<html>
<head>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(mockNBANextData)}</script>
</head>
<body></body>
</html>
`;

// Global fetch mocking helper
let fetchMock = null;
const originalFetch = globalThis.fetch;

test.before(() => {
	process.env.NODE_ENV = 'test';
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

test.describe('NBAScraper & Pipeline Integration', () => {
	test('getSeasonGameSlugs should fetch, validate and map game slugs with prefix filters', async () => {
		const scraper = new NBAScraper();

		fetchMock = async (url, config) => {
			assert.match(url, /00_full_schedule\.json/);
			return {
				ok: true,
				status: 200,
				json: async () => mockNBALeagueGameLogResponse
			};
		};

		const result = await scraper.getSeasonGameSlugs('2023');
		assert.equal(result, scraper);
		// 0092300001 should be filtered out! Only 0022300001 and 0022300002 are preserved.
		assert.deepEqual(scraper.gameSlugs, [
			'lal-vs-bos-0022300001',
			'phx-vs-gsw-0022300002'
		]);
	});

	test('getAPIBoxScore should fetch, validate against schema and return nested game state directly', async () => {
		const scraper = new NBAScraper();

		fetchMock = async (url, config) => {
			assert.match(url, /nba\.com\/game\//);
			return {
				ok: true,
				status: 200,
				text: async () => mockNBAGameHtmlResponse
			};
		};

		const data = await scraper.getAPIBoxScore('0022300001');
		assert.equal(data.gameId, "0022300001");
		assert.equal(data.homeTeam.teamName, "Celtics");
		assert.equal(data.awayTeam.teamName, "Lakers");
		assert.equal(data.homeTeam.players.length, 1);
		assert.equal(data.awayTeam.players.length, 1);
	});

	test('scrapeAndSaveBoxScore should write correct flat nested JSON to file', async () => {
		const scraper = new NBAScraper();
		const tempDir = path.join(PROJECT_ROOT, 'data/JSON/NBA_test_temp');

		fetchMock = async (url, config) => {
			return {
				ok: true,
				status: 200,
				text: async () => mockNBAGameHtmlResponse
			};
		};

		try {
			await fs.rm(tempDir, { recursive: true, force: true });

			const savedData = await scraper.scrapeAndSaveBoxScore('0022300001', 'traditional', tempDir);
			assert.equal(savedData.gameId, "0022300001");

			const expectedFilePath = path.join(tempDir, 'boxscore_0022300001_traditional.json');
			const fileExists = await fs.access(expectedFilePath).then(() => true).catch(() => false);
			assert.equal(fileExists, true);

			const fileContent = await fs.readFile(expectedFilePath, 'utf8');
			const parsedData = JSON.parse(fileContent);

			assert.deepEqual(parsedData, savedData);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test('getGameEndpoint and getGameUrl should return correct routing values', () => {
		const scraper = new NBAScraper();
		assert.equal(scraper.getGameEndpoint('0022300001'), '/game/0022300001');
		assert.equal(scraper.getGameUrl('0022300001'), 'https://www.nba.com/game/0022300001');
	});

	test('Full Transform & Load Integration for NBA', async () => {
		const testYear = '1985'; // Custom year to keep SQL staging isolated
		const rawDir = path.resolve('data/raw/nba', testYear);
		const transformedDir = path.resolve('data/transformed/nba', testYear);

		try {
			await fs.mkdir(rawDir, { recursive: true });
			await fs.writeFile(path.join(rawDir, '0022300001.json'), JSON.stringify(mockNBANextData.props.pageProps.game), 'utf8');

			// 1. Run Transform Stage
			const transformed = await transformStage('nba', testYear);
			assert.equal(transformed.players.length, 2);
			assert.equal(transformed.teams.length, 2);

			// Check ISO-8601 minutes conversion inside Transform
			const kdPlayer = transformed.players.find(p => p.player_id === 201142);
			assert.equal(kdPlayer.player_name, "Kevin Durant");
			assert.equal(kdPlayer.min, "36.2"); // PT36M12.00S converted to 36.2

			const lebronPlayer = transformed.players.find(p => p.player_id === 2544);
			assert.equal(lebronPlayer.player_name, "LeBron James");
			assert.equal(lebronPlayer.min, "35"); // PT35M00.00S converted to 35

			// Check team minutes parsed correctly
			const homeTeam = transformed.teams.find(t => t.team_id === 1610612738);
			assert.equal(homeTeam.min, "200"); // PT200M converted to 200

			// 2. Run Load Stage (This will verify NBA.sqlite creation and dynamic migrations)
			await loadStage('nba', testYear, transformed);

			const db = await initDatabase('nba');
			try {
				const playerRows = db.prepare(`SELECT * FROM player_game_stats WHERE league = ? AND season = ? ORDER BY player_id`)
					.all('nba', testYear);
				assert.equal(playerRows.length, 2);
				assert.equal(playerRows[0].player_name, "LeBron James");
				assert.equal(playerRows[1].player_name, "Kevin Durant");
				assert.equal(playerRows[1].min, "36.2");

				const teamRows = db.prepare(`SELECT * FROM team_game_stats WHERE league = ? AND season = ? ORDER BY team_id`)
					.all('nba', testYear);
				assert.equal(teamRows.length, 2);
				assert.equal(teamRows[0].team_name, "Boston Celtics");
			} finally {
				db.destroy();
			}

		} finally {
			// Cleanup generated raw and transformed paths
			await fs.rm(rawDir, { recursive: true, force: true });
			await fs.rm(transformedDir, { recursive: true, force: true });
			await fs.rm(path.resolve('data/SQL/NBA.sqlite'), { force: true });
		}
	});
});
