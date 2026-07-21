import { HTTPClient, validateSchema } from "#utils";
import fs from "fs/promises";
import path from "path";

/**
 * @description Row mapping of a result set object from the API
 * @typedef {Record<string, any>} RowMappedData
 */

/**
 * @description Mapped box score containing arrays of player and team records
 * @typedef {Object} MappedBoxScore
 * @property {RowMappedData[]} players - The player stats rows mapped to objects
 * @property {RowMappedData[]} teams - The team stats rows mapped to objects
 */

/**
 * @description Result set representation in the WNBA/NBA Stats API
 * @typedef {Object} WNBAResultSet
 * @property {string} name - The name of the result set
 * @property {string[]} headers - The column headers
 * @property {any[][]} rowSet - The row data values matching the headers
 */

/**
 * @description WNBA/NBA Stats API standard response shape
 * @typedef {Object} WNBAStatsResponse
 * @property {string} resource - The name of the resource queried
 * @property {Record<string, any>} parameters - The parameters passed to the endpoint
 * @property {WNBAResultSet[]} resultSets - The returned list of result sets
 */

export class WNBAScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper configuration options
	 * @param {'traditional' | 'advanced'} [options.boxscoreType='traditional'] - The type of box score to fetch
	 */
	constructor(options = {}) {
		super(
			'https://stats.wnba.com/stats',
			{
				'referrer': 'https://stats.wnba.com',
				'origin': 'https://stats.wnba.com',
				'accept': 'application/json, text/plain, */*',
				'accept-language': 'en-US,en;q=0.9',
				'x-nba-stats-origin': 'stats',
				'x-nba-stats-token': 'true'
			}
		);
		/** @type {string[]} */
		this.gameSlugs = [];
		/** @type {'traditional' | 'advanced'} */
		this.boxscoreType = options.boxscoreType || 'traditional';
	}

	/**
	 * @description Fetches the league game log for a given season and returns the game slugs.
	 * @param {number | string} year - The year (season) for which to fetch data
	 * @returns {Promise<WNBAScraper>} - Returns the scraper instance for chaining
	 * @throws {Error} - If the request fails or schema validation fails
	 */
	async getSeasonGameSlugs(year) {
		const historicalUrl = `https://data.wnba.com/data/10s/v2015/json/mobile_teams/wnba/${year}/league/10_full_schedule.json`;
		const currentSeasonUrl = `https://cdn.wnba.com/static/json/staticData/scheduleLeagueV2.json`;

		let data;
		try {
			// Try historical URL first with low retries and delay to fail-fast
			data = await this.request(historicalUrl, {}, 1, 1000);
		} catch (err) {
			console.log(`⚠️ Historical schedule not found or forbidden for ${year}. Falling back to current season schedule...`);
			data = await this.request(currentSeasonUrl, {}, 3, 5000);
		}

		// Validate against JSON schema
		validateSchema('wnba/leaguegamelog.json', data);

		/** @type {string[]} */
		const slugs = [];

		if (data && Array.isArray(data.lscd)) {
			// Historical schedule format
			for (const monthObj of data.lscd) {
				if (monthObj && monthObj.mscd && Array.isArray(monthObj.mscd.g)) {
					for (const game of monthObj.mscd.g) {
						if (game && game.gid) {
							const visitor = (game.v && game.v.ta) ? game.v.ta.toLowerCase() : '';
							const home = (game.h && game.h.ta) ? game.h.ta.toLowerCase() : '';
							const gameId = game.gid;
							if (visitor && home) {
								slugs.push(`${visitor}-vs-${home}-${gameId}`);
							} else {
								slugs.push(`matchup-${gameId}`);
							}
						}
					}
				}
			}
		} else if (data && data.leagueSchedule && Array.isArray(data.leagueSchedule.gameDates)) {
			// Current season schedule format
			for (const dateObj of data.leagueSchedule.gameDates) {
				if (dateObj && Array.isArray(dateObj.games)) {
					for (const game of dateObj.games) {
						if (game && game.gameId) {
							const visitor = (game.awayTeam && game.awayTeam.teamTricode) ? game.awayTeam.teamTricode.toLowerCase() : '';
							const home = (game.homeTeam && game.homeTeam.teamTricode) ? game.homeTeam.teamTricode.toLowerCase() : '';
							const gameId = game.gameId;
							if (visitor && home) {
								slugs.push(`${visitor}-vs-${home}-${gameId}`);
							} else {
								slugs.push(`matchup-${gameId}`);
							}
						}
					}
				}
			}
		}

		this.gameSlugs = [...new Set(slugs)];

		return this;
	}

	/**
	 * @description Returns the API endpoint for fetching box score data.
	 * @param {string} gameId - The ID of the game
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @returns {string} - The endpoint path
	 */
	getGameEndpoint(gameId, type) {
		const resolvedType = type || this.boxscoreType;
		return `/boxscore${resolvedType}v2`;
	}

	/**
	 * @description Returns the complete URL (endpoint + query parameters) for fetching box score data.
	 * @param {string} gameId - The ID of the game
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @returns {string} - The full request URL
	 */
	getGameUrl(gameId, type) {
		return `https://www.wnba.com/game/${gameId}`;
	}

	/**
	 * @description Universal fetch runner with automatic retry and exponential back off on rate limits and network errors
	 */
	async request(endpoint, options = {}, retries = 3, delay = 1000) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
		const isStatsApi = url.includes('stats.wnba.com');
		const originalHeaders = this.defaultHeaders;

		if (!isStatsApi) {
			this.defaultHeaders = {
				'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'accept': 'application/json'
			};
		}

		try {
			if (url.includes('wnba.com/game/')) {
				const config = {
					...options,
					headers: {
						'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'accept-language': 'en-US,en;q=0.9',
						...options.headers
					}
				};

				const response = await fetch(url, config);
				if (response.status === 429 || response.status >= 500) {
					if (retries > 0) {
						console.warn(`[HTTP ${ response.status }] Retrying ${ url } in ${ delay }ms... (${ retries } left)`);
						await new Promise( resolve => setTimeout(resolve, delay) );
						return this.request(endpoint, options, retries - 1, delay * 2);
					}
				}

				if (!response.ok) {
					throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
				}

				const html = await response.text();
				const match = html.match(/<script id=\"__NEXT_DATA__\" type=\"application\/json\">(.*?)<\/script>/s);
				if (!match) {
					throw new Error(`Could not find __NEXT_DATA__ script tag in HTML response from ${url}`);
				}

				const nextData = JSON.parse(match[1]);
				const game = nextData?.props?.pageProps?.game;
				if (!game) {
					throw new Error(`Could not find game pageProps in __NEXT_DATA__ from ${url}`);
				}

				return this.mapNextDataToStatsAPI(game);
			}

			return await super.request(endpoint, options, retries, delay);
		} catch (error) {
			if (retries > 0) {
				console.warn(`[HTTP Error] ${ error.message || error }. Retrying ${ url } in ${ delay }ms... (${ retries } left)`);
				await new Promise( resolve => setTimeout(resolve, delay) );
				return this.request(endpoint, options, retries - 1, delay * 2);
			}
			throw error;
		} finally {
			this.defaultHeaders = originalHeaders;
		}
	}

	/**
	 * @description Maps the Next.js game pageProps state to standard Stats API traditional boxscore response structure.
	 * @param {Object} game - The pageProps game object
	 * @returns {Object} - Standardized Stats API-like JSON response
	 */
	mapNextDataToStatsAPI(game) {
		const gameId = game.gameId || '';

		const playerHeaders = [
			"GAME_ID", "TEAM_ID", "TEAM_ABBREVIATION", "TEAM_CITY", "PLAYER_ID", "PLAYER_NAME", "START_POSITION", "COMMENT", "MIN",
			"FGM", "FGA", "FG_PCT", "FG3M", "FG3A", "FG3_PCT", "FTM", "FTA", "FT_PCT", "OREB", "DREB", "REB", "AST", "STL", "BLK", "TO", "PF", "PTS", "PLUS_MINUS"
		];

		const teamHeaders = [
			"GAME_ID", "TEAM_ID", "TEAM_NAME", "TEAM_ABBREVIATION", "TEAM_CITY", "MIN",
			"FGM", "FGA", "FG_PCT", "FG3M", "FG3A", "FG3_PCT", "FTM", "FTA", "FT_PCT", "OREB", "DREB", "REB", "AST", "STL", "BLK", "TO", "PF", "PTS", "PLUS_MINUS"
		];

		const playerRowSet = [];
		const teamRowSet = [];

		const processTeam = (teamObj) => {
			if (!teamObj) return;
			const teamId = teamObj.teamId;
			const teamName = teamObj.teamName || '';
			const teamCity = teamObj.teamCity || '';
			const teamAbbrev = teamObj.teamTricode || '';

			// Process Team Stats
			const tStats = teamObj.statistics || {};
			const teamRow = [
				gameId,
				teamId,
				`${teamCity} ${teamName}`.trim(),
				teamAbbrev,
				teamCity,
				tStats.minutes || '200:00',
				tStats.fieldGoalsMade ?? 0,
				tStats.fieldGoalsAttempted ?? 0,
				tStats.fieldGoalsPercentage ?? 0,
				tStats.threePointersMade ?? 0,
				tStats.threePointersAttempted ?? 0,
				tStats.threePointersPercentage ?? 0,
				tStats.freeThrowsMade ?? 0,
				tStats.freeThrowsAttempted ?? 0,
				tStats.freeThrowsPercentage ?? 0,
				tStats.reboundsOffensive ?? 0,
				tStats.reboundsDefensive ?? 0,
				tStats.reboundsTotal ?? 0,
				tStats.assists ?? 0,
				tStats.steals ?? 0,
				tStats.blocks ?? 0,
				tStats.turnovers ?? 0,
				tStats.foulsPersonal ?? 0,
				tStats.points ?? 0,
				tStats.plusMinusPoints ?? 0
			];
			teamRowSet.push(teamRow);

			// Process Team Players
			const players = teamObj.players || [];
			for (const p of players) {
				const playerId = p.personId;
				const firstName = p.firstName || '';
				const familyName = p.familyName || '';
				const playerName = `${firstName} ${familyName}`.trim();
				const startPosition = p.position || '';
				const comment = p.comment || '';
				const pStats = p.statistics || {};

				const playerRow = [
					gameId,
					teamId,
					teamAbbrev,
					teamCity,
					playerId,
					playerName,
					startPosition,
					comment,
					pStats.minutes || null,
					pStats.fieldGoalsMade ?? 0,
					pStats.fieldGoalsAttempted ?? 0,
					pStats.fieldGoalsPercentage ?? 0,
					pStats.threePointersMade ?? 0,
					pStats.threePointersAttempted ?? 0,
					pStats.threePointersPercentage ?? 0,
					pStats.freeThrowsMade ?? 0,
					pStats.freeThrowsAttempted ?? 0,
					pStats.freeThrowsPercentage ?? 0,
					pStats.reboundsOffensive ?? 0,
					pStats.reboundsDefensive ?? 0,
					pStats.reboundsTotal ?? 0,
					pStats.assists ?? 0,
					pStats.steals ?? 0,
					pStats.blocks ?? 0,
					pStats.turnovers ?? 0,
					pStats.foulsPersonal ?? 0,
					pStats.points ?? 0,
					pStats.plusMinusPoints ?? 0
				];
				playerRowSet.push(playerRow);
			}
		};

		processTeam(game.homeTeam);
		processTeam(game.awayTeam);

		return {
			resource: "boxscore",
			parameters: { GameID: gameId },
			resultSets: [
				{
					name: "PlayerStats",
					headers: playerHeaders,
					rowSet: playerRowSet
				},
				{
					name: "TeamStats",
					headers: teamHeaders,
					rowSet: teamRowSet
				}
			]
		};
	}

	/**
	 * @description Fetches the traditional or advanced box score for a game, validates it, and returns mapped data.
	 * @param {string} gameId - The ID of the game whose box score we need to fetch
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @returns {Promise<MappedBoxScore>} - The mapped player and team stats
	 * @throws {Error} - If the request fails or schema validation fails
	 */
	async getAPIBoxScore(gameId, type) {
		const resolvedType = type || this.boxscoreType;
		const url = this.getGameUrl(gameId, resolvedType);

		const data = await this.request(url, {}, 3, 5000);

		// Validate against JSON schema
		validateSchema('wnba/boxscore.json', data);

		const playerStatsSet = data.resultSets.find( set => set.name === 'PlayerStats' );
		const teamStatsSet = data.resultSets.find( set => set.name === 'TeamStats' );

		return {
			players: this.#mapResultSet(playerStatsSet),
			teams: this.#mapResultSet(teamStatsSet)
		};
	}

	/**
	 * @description Fetches, validates, maps and saves a game's box score as JSON to the output directory.
	 * @param {string} gameId - The ID of the game to fetch and save
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @param {string} [outputDir='data/JSON/WNBA'] - The output directory where the JSON file will be written
	 * @returns {Promise<MappedBoxScore>} - The mapped box score data saved
	 * @throws {Error} - If the request, schema validation, or writing file fails
	 */
	async scrapeAndSaveBoxScore(gameId, type, outputDir = 'data/JSON/WNBA') {
		const resolvedType = type || this.boxscoreType;
		const mappedData = await this.getAPIBoxScore(gameId, resolvedType);

		await fs.mkdir(outputDir, { recursive: true });
		const fileName = `boxscore_${gameId}_${resolvedType}.json`;
		const filePath = path.join(outputDir, fileName);

		await fs.writeFile(filePath, JSON.stringify(mappedData, null, 2), 'utf8');
		return mappedData;
	}

	/**
	 * @description Helper to map a result set with headers and rows into an array of objects
	 * @param {WNBAResultSet} [resultSet] - The result set object to map
	 * @returns {RowMappedData[]} - Array of objects with column headers as keys
	 */
	#mapResultSet(resultSet) {
		if (!resultSet) return [];

		const headers = resultSet.headers;
		return resultSet.rowSet.map( row => {
			/** @type {RowMappedData} */
			let obj = {};
			row.forEach( (value, index) => {
				obj[ headers[ index ] ] = value;
			} );
			return obj;
		} );
	}
}
