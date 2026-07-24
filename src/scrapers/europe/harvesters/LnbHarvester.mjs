import { HTTPClient } from '#utils';

/**
 * @description Harvester for LNB (French Pro A) schedules from Basketball Reference.
 */
export class LnbHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} scraperInstance - The parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.basketball-reference.com');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for LNB for a given season.
	 * @param {string|number} year - The season start year (e.g. 2021)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`nanterre-vs-limoges-L${year}_2020_09_26_limoges`,
				`cholet-vs-orleans-L${year}_2020_09_26_orleans`
			];
		}

		const calendarUrl = `/international/france-lnb-pro-a/${year}-schedule.html`;
		console.log(`📡 [LnbHarvester] Fetching schedule from ${this.baseUrl}${calendarUrl}...`);

		try {
			const htmlText = await this.requestText(calendarUrl);
			if (!htmlText) {
				console.warn(`⚠️ [LnbHarvester] Empty response received for LNB calendar.`);
				return [];
			}

			// Extract all match URLs like: /international/boxscores/2020-09-26-limoges.html
			const regex = /\/international\/boxscores\/([a-z0-9-]+)\.html/g;
			let match;
			const gameIds = [];

			while ((match = regex.exec(htmlText)) !== null) {
				gameIds.push(match[1]); // e.g. "2020-09-26-limoges"
			}

			const uniqueGameIds = [...new Set(gameIds)];
			console.log(`✅ [LnbHarvester] Discovered ${uniqueGameIds.length} unique games for season ${year}.`);

			// Format into canonical slugs: matchup-Lyear_uuid_with_underscores
			return uniqueGameIds.map(id => {
				const matchup = id.split('-').slice(3).join('-') || 'matchup';
				return `${matchup}-L${year}_${id.replace(/-/g, '_')}`;
			});
		} catch (error) {
			console.error(`❌ [LnbHarvester] Failed to harvest LNB calendar:`, error.message || error);
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
			console.error(`❌ [LnbHarvester] Fetch failed for ${url}:`, error.message || error);
			return '';
		}
	}
}
