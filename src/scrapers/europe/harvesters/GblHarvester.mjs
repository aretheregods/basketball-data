import { HTTPClient } from '#utils';

/**
 * @description Harvester for Greek Basketball (GBL) schedules from esake.gr.
 * Discovers and collects match IDs from the GBL results / calendar page.
 */
export class GblHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.esake.gr');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for GBL for a given season.
	 * @param {string|number} year - The season start year (e.g. 2026)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`olympiacos-vs-panathinaikos-G${year}_65708E5D`,
				`peristeri-vs-aek-G${year}_712C91E8`
			];
		}

		const resultsUrl = `/en/action/EsakeResults?mode=2`;
		console.log(`📡 [GblHarvester] Fetching results calendar from ${this.baseUrl}${resultsUrl}...`);

		try {
			const htmlText = await this.requestText(resultsUrl);
			if (!htmlText) {
				console.warn(`⚠️ [GblHarvester] Empty response received for GBL calendar.`);
				return [];
			}

			// Extract match IDs using EsakegameView?idgame=... pattern
			const regex = /idgame=([A-F0-9a-f]+)/g;
			let match;
			const gameIds = [];

			while ((match = regex.exec(htmlText)) !== null) {
				gameIds.push(match[1].toUpperCase());
			}

			const uniqueGameIds = [...new Set(gameIds)];
			console.log(`✅ [GblHarvester] Discovered ${uniqueGameIds.length} unique GBL games.`);

			// Format into canonical slugs: matchup-Gyear_gameCode
			return uniqueGameIds.map(id => `matchup-G${year}_${id}`);
		} catch (error) {
			console.error(`❌ [GblHarvester] Failed to harvest GBL calendar:`, error.message || error);
			return [];
		}
	}

	/**
	 * @description Helper to request HTML text instead of parsing JSON.
	 * @param {string} endpoint
	 * @returns {Promise<string>}
	 */
	async requestText(endpoint) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
		try {
			const response = await fetch(url, { headers: this.defaultHeaders });
			if (!response.ok) {
				throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
			}
			return await response.text();
		} catch (error) {
			console.error(`❌ [GblHarvester] Fetch failed for ${url}:`, error.message || error);
			return '';
		}
	}
}
