import { HTTPClient } from '#utils';

/**
 * @description Helper to extract the 7-digit FIBA LiveStats/Genius Sports game ID from a game record.
 * @param {Object} game - Game record from the CEBL API
 * @returns {string|null} - Extracted FIBA game ID or null
 */
function extractFibaId(game) {
	if (game.stats_url_en) {
		const match = String(game.stats_url_en).match(/\/([0-9]+)\/?(?:index\.html)?$/i);
		if (match) return match[1];
	}
	if (game.stats_url_fr) {
		const match = String(game.stats_url_fr).match(/\/([0-9]+)\/?(?:index.*)?$/i);
		if (match) return match[1];
	}
	if (game.cebl_stats_url_en) {
		const match = String(game.cebl_stats_url_en).match(/[?&]id=([0-9]+)/i);
		if (match) return match[1];
	}
	if (game.cebl_stats_url_fr) {
		const match = String(game.cebl_stats_url_fr).match(/[?&]id=([0-9]+)/i);
		if (match) return match[1];
	}
	return null;
}

/**
 * @class CeblHarvester
 * @description Harvester for the Canadian Elite Basketball League (CEBL) schedule from api.data.cebl.ca.
 * Queries raw JSON schedule REST API endpoints and extracts the actual FIBA LiveStats ID for completed games.
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
				.filter(game => {
					// Only extract games that are COMPLETE to avoid fetching unplayed future games
					return game && String(game.status).toUpperCase() === 'COMPLETE';
				})
				.map(game => extractFibaId(game))
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

			console.log(`✅ [CeblHarvester] Successfully harvested ${slugs.length} completed CEBL game slugs for season ${year}.`);
			return slugs;
		} catch (error) {
			console.error(`❌ [CeblHarvester] Failed to harvest CEBL schedule:`, error.message || error);
			return [];
		}
	}
}

export default CeblHarvester;
