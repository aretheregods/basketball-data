import { HTTPClient, validateSchema } from "#utils";
import fs from "fs/promises";
import path from "path";

/**
 * @description Mapped NBA box score containing flat nested game data
 * @typedef {Object} NBAGameData
 * @property {string} gameId - Unique identifier for the game
 * @property {Object} homeTeam - The home team data
 * @property {Object} awayTeam - The away team data
 */

export class NBAScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper configuration options
	 * @param {'traditional' | 'advanced'} [options.boxscoreType='traditional'] - The type of box score to fetch (for compliance/compatibility)
	 */
	constructor(options = {}) {
		// Shift the base URL away from stats.nba.com to prevent Akamai timeout blocks
		super(
			'https://www.nba.com',
			{
				'referrer': 'https://www.nba.com',
				'origin': 'https://www.nba.com',
				'accept': 'application/json, text/plain, */*',
				'accept-language': 'en-US,en;q=0.9'
			}
		);
		/** @type {string[]} */
		this.gameSlugs = [];
		/** @type {'traditional' | 'advanced'} */
		this.boxscoreType = options.boxscoreType || 'traditional';
	}

	/**
	 * @description Fetches the league schedule for a given season and returns the game slugs.
	 * Filters for valid game ID prefixes: 001 (Preseason), 002 (Regular Season), 004 (Playoffs), 005 (Play-In).
	 * @param {number | string} year - The year (season) for which to fetch data
	 * @returns {Promise<NBAScraper>} - Returns the scraper instance for chaining
	 * @throws {Error} - If the request fails or schema validation fails
	 */
	async getSeasonGameSlugs(year) {
		const historicalUrl = `https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/${year}/league/00_full_schedule.json`;
		const currentSeasonUrl = `https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json`;

		let data;
		try {
			// Try historical URL first
			data = await this.request(historicalUrl, {}, 1, 1000);
		} catch (err) {
			console.log(`⚠️ Historical schedule not found or forbidden for ${year}. Falling back to current season schedule...`);
			data = await this.request(currentSeasonUrl, {}, 3, 5000);
		}

		// Validate against JSON schema
		validateSchema('nba/leaguegamelog.json', data);

		/** @type {string[]} */
		const slugs = [];
		const validPrefixes = ['001', '002', '004', '005'];

		if (data && Array.isArray(data.lscd)) {
			// Historical schedule format
			for (const monthObj of data.lscd) {
				if (monthObj && monthObj.mscd && Array.isArray(monthObj.mscd.g)) {
					for (const game of monthObj.mscd.g) {
						if (game && game.gid) {
							const gameId = game.gid;
							// Filter out non-game events or other prefixes
							const prefix = gameId.substring(0, 3);
							if (!validPrefixes.includes(prefix)) {
								continue;
							}
							const visitor = (game.v && game.v.ta) ? game.v.ta.toLowerCase() : '';
							const home = (game.h && game.h.ta) ? game.h.ta.toLowerCase() : '';
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
							const gameId = game.gameId;
							// Filter out non-game events or other prefixes
							const prefix = gameId.substring(0, 3);
							if (!validPrefixes.includes(prefix)) {
								continue;
							}
							const visitor = (game.awayTeam && game.awayTeam.teamTricode) ? game.awayTeam.teamTricode.toLowerCase() : '';
							const home = (game.homeTeam && game.homeTeam.teamTricode) ? game.homeTeam.teamTricode.toLowerCase() : '';
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
		return `/game/${gameId}`;
	}

	/**
	 * @description Returns the complete URL (endpoint + query parameters) for fetching box score data.
	 * @param {string} gameId - The ID of the game
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @returns {string} - The full request URL
	 */
	getGameUrl(gameId, type) {
		return `https://www.nba.com/game/${gameId}`;
	}

	/**
	 * @description Universal fetch runner with automatic retry and exponential backoff
	 */
	async request(endpoint, options = {}, retries = 3, delay = 1000) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
		const isNbaUrl = url.includes('nba.com');
		const originalHeaders = this.defaultHeaders;

		if (!isNbaUrl) {
			this.defaultHeaders = {
				'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'accept': 'application/json'
			};
		}

		try {
			if (url.includes('nba.com/game/')) {
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

				// Return the nested state directly rather than translating it back to clunky legacy structures
				return game;
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
	 * @description Fetches the box score for a game, validates it, and returns flat nested game data.
	 * @param {string} gameId - The ID of the game whose box score we need to fetch
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @returns {Promise<NBAGameData>} - The flat nested box score game data
	 * @throws {Error} - If the request fails or schema validation fails
	 */
	async getAPIBoxScore(gameId, type) {
		const resolvedType = type || this.boxscoreType;
		const url = this.getGameUrl(gameId, resolvedType);

		const data = await this.request(url, {}, 3, 5000);

		// Validate against JSON schema
		validateSchema('nba/boxscore.json', data);

		return data;
	}

	/**
	 * @description Fetches, validates, and saves a game's box score as JSON to the output directory.
	 * @param {string} gameId - The ID of the game to fetch and save
	 * @param {'traditional' | 'advanced'} [type] - The type of box score to fetch
	 * @param {string} [outputDir='data/JSON/NBA'] - The output directory where the JSON file will be written
	 * @returns {Promise<NBAGameData>} - The box score data saved
	 * @throws {Error} - If the request, schema validation, or writing file fails
	 */
	async scrapeAndSaveBoxScore(gameId, type, outputDir = 'data/JSON/NBA') {
		const resolvedType = type || this.boxscoreType;
		const mappedData = await this.getAPIBoxScore(gameId, resolvedType);

		await fs.mkdir(outputDir, { recursive: true });
		const fileName = `boxscore_${gameId}_${resolvedType}.json`;
		const filePath = path.join(outputDir, fileName);

		await fs.writeFile(filePath, JSON.stringify(mappedData, null, 2), 'utf8');
		return mappedData;
	}
}
