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
	 */
	constructor() {
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
	}

	/**
	 * @description Fetches the league game log for a given season and returns the game slugs.
	 * @param {number | string} year - The year (season) for which to fetch data
	 * @returns {Promise<WNBAScraper>} - Returns the scraper instance for chaining
	 * @throws {Error} - If the request fails or schema validation fails
	 */
	async getSeasonGameSlugs(year) {
		const url = `/leaguegamelog?Counter=0&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=${ year }&SeasonType=02&Sorter=DATE`;

		const data = await this.request(url, {}, 3, 5000);

		// Validate against JSON schema
		validateSchema('wnba/leaguegamelog.json', data);

		const rows = data.resultSets[0].rowSet;
		const columns = data.resultSets[0].headers;

		const gameIdIdx = columns.indexOf('GAME_ID');
		const matchupIdx = columns.indexOf('MATCHUP');

		if (gameIdIdx === -1 || matchupIdx === -1) {
			throw new Error("Required headers 'GAME_ID' or 'MATCHUP' missing in response");
		}

		/** @type {string[]} */
		const slugs = rows.map( row => {
			const gameId = row[gameIdIdx];
			const matchup = row[matchupIdx];
			const cleanMatchup = matchup.toLowerCase().replace(/[\s\.]+/g, '').replace('@', '-vs-');
			return `${ cleanMatchup }-${ gameId }`;
		} );

		this.gameSlugs = [...new Set(slugs)];

		return this;
	}

	/**
	 * @description Returns the API endpoint for fetching box score data.
	 * @param {string} gameId - The ID of the game
	 * @returns {string} - The endpoint path
	 */
	getGameEndpoint(gameId) {
		return '/boxscoretraditionalv2';
	}

	/**
	 * @description Returns the complete URL (endpoint + query parameters) for fetching box score data.
	 * @param {string} gameId - The ID of the game
	 * @returns {string} - The full request URL
	 */
	getGameUrl(gameId) {
		const endpoint = this.getGameEndpoint(gameId);
		return `${endpoint}?EndPeriod=10&EndRange=28800&GameID=${gameId}&RangeType=0&StartPeriod=1&StartRange=0`;
	}

	/**
	 * @description Fetches the traditional or advanced box score for a game, validates it, and returns mapped data.
	 * @param {string} gameId - The ID of the game whose box score we need to fetch
	 * @param {'traditional' | 'advanced'} [type='traditional'] - The type of box score to fetch
	 * @returns {Promise<MappedBoxScore>} - The mapped player and team stats
	 * @throws {Error} - If the request fails or schema validation fails
	 */
	async getAPIBoxScore(gameId, type = 'traditional') {
		const endpoint = `/boxscore${ type }v2`;
		const url = `${endpoint}?EndPeriod=10&EndRange=28800&GameID=${ gameId }&RangeType=0&StartPeriod=1&StartRange=0`;

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
	 * @param {'traditional' | 'advanced'} [type='traditional'] - The type of box score to fetch
	 * @param {string} [outputDir='data/JSON/WNBA'] - The output directory where the JSON file will be written
	 * @returns {Promise<MappedBoxScore>} - The mapped box score data saved
	 * @throws {Error} - If the request, schema validation, or writing file fails
	 */
	async scrapeAndSaveBoxScore(gameId, type = 'traditional', outputDir = 'data/JSON/WNBA') {
		const mappedData = await this.getAPIBoxScore(gameId, type);

		await fs.mkdir(outputDir, { recursive: true });
		const fileName = `boxscore_${gameId}_${type}.json`;
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
