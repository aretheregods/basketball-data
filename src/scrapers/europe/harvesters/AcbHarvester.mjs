import { HTTPClient } from '#utils';

/**
 * @description Harvester for Spanish Liga ACB schedules.
 * Retrieves all match statistics page links from the calendar and converts them into canonical slugs.
 */
export class AcbHarvester extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.acb.com');
	}

	/**
	 * @description Fetches all game slugs/IDs for ACB for a given season.
	 * @param {string|number} year - The season start year (e.g., 2025)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const calendarUrl = '/es/liga/calendario';
		console.log(`📡 [AcbHarvester] Fetching calendar from ${this.baseUrl}${calendarUrl}...`);

		// We use standard request (fetch) to retrieve the calendar HTML page
		const responseText = await this.requestText(calendarUrl);
		if (!responseText) {
			console.warn('⚠️ [AcbHarvester] Calendar response is empty.');
			return [];
		}

		// Regex to match match URLs like: https://live.acb.com/partidos/barca-vs-valencia-basket-105373/estadisticas
		// Note that URLs can have optional protocol, path prefix, etc.
		const regex = /href="https:\/\/live\.acb\.com\/partidos\/([^/"]+)\/estadisticas"/g;
		let match;
		const slugs = [];

		while ((match = regex.exec(responseText)) !== null) {
			const matchSegment = match[1]; // e.g. "barca-vs-valencia-basket-105373"
			const parts = matchSegment.split('-');
			const gameId = parts.pop(); // e.g. "105373"
			const matchup = parts.join('-'); // e.g. "barca-vs-valencia-basket"

			// Canonical format: matchup-Aseason_gameId
			slugs.push(`${matchup}-A${year}_${gameId}`);
		}

		const uniqueSlugs = [...new Set(slugs)];
		console.log(`✅ [AcbHarvester] Discovered ${uniqueSlugs.length} unique game slugs for ACB year ${year}.`);
		return uniqueSlugs;
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
			console.error(`❌ [AcbHarvester] Fetch failed for ${url}:`, error.message || error);
			return '';
		}
	}
}
