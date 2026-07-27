import { HTTPClient } from '#utils';

/**
 * @class CeblHarvester
 * @description Harvester for the Canadian Elite Basketball League (CEBL) schedule from api.data.cebl.ca.
 * Queries raw JSON schedule REST API endpoints without requiring a browser.
 * @extends {HTTPClient}
 */
export class CeblHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://api.data.cebl.ca');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for CEBL for a given season.
	 * @param {string|number} year - The season year (e.g., '2026')
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs directly to avoid real network calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`cebl-${year}-10492`,
				`cebl-${year}-10493`
			];
		}

		const apiUrl = `https://api.data.cebl.ca/games/${year}/`;
		console.log(`📡 [CeblHarvester] Harvesting CEBL season ${year} from API...`);

		const headers = {
			'x-api-key': '800chyzv2hvur3z0ogh39cve2zok0c',
			'origin': 'https://cebl-stats-hub.web.app',
			'referer': 'https://cebl-stats-hub.web.app/',
			'accept': 'application/json, text/plain, */*'
		};

		try {
			const response = await this.request(apiUrl, { headers });
			const gameList = Array.isArray(response) ? response : (response.games || []);

			const gameIds = gameList
				.map(game => game.id || game.game_id)
				.filter(Boolean);

			const uniqueIds = [...new Set(gameIds)];
			const slugs = uniqueIds.map(id => `cebl-${year}-${id}`);

			// Populate scraper map if scraper exists
			if (this.scraper && typeof this.scraper.setGameUrl === 'function') {
				uniqueIds.forEach(id => {
					const fullUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${id}/data.json`;
					this.scraper.setGameUrl(`cebl-${year}-${id}`, fullUrl);
					this.scraper.setGameUrl(id, fullUrl);
				});
			}

			console.log(`✅ [CeblHarvester] Successfully harvested ${slugs.length} CEBL game slugs for season ${year}.`);
			return slugs;
		} catch (error) {
			console.error(`❌ [CeblHarvester] Failed to harvest CEBL schedule:`, error.message || error);
			return [];
		}
	}
}

export default CeblHarvester;
