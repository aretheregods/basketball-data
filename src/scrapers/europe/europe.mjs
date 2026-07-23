import { HTTPClient } from '#utils';
import { EuroleagueEngine } from './engines/EuroleagueEngine.mjs';
import { FibaLiveStatsEngine } from './engines/FibaLiveStatsEngine.mjs';
import { SsrHydrationEngine } from './engines/SsrHydrationEngine.mjs';
import { DomesticRestEngine } from './engines/DomesticRestEngine.mjs';

/**
 * @description EuropeScraper is the master orchestrator for European basketball competitions.
 * It delegates schedule harvesting and box score fetching to specialized backend provider engines.
 */
export class EuropeScraper extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Scraper options
	 * @param {string} [options.competitions='euroleague'] - Comma-separated list or array of target competitions
	 * @param {string} [options.boxscoreType='traditional'] - Box score metric type
	 */
	constructor(options = {}) {
		super('https://live.euroleague.net/api');

		// Parse competitions list (can be 'all', or comma-separated list like 'euroleague,eurocup,bcl,acb,lba,lnb,aba,lkl,gbl,bbl,bsl,israel')
		const rawComps = options.competitions || 'euroleague';
		if (rawComps === 'all') {
			this.competitions = [
				'euroleague', 'eurocup', 'bcl',
				'aba', 'lkl', 'gbl',               // Genius Sports / FIBA LiveStats
				'acb', 'lba', 'lnb',               // SSR Hydration
				'bbl', 'bsl', 'israel'             // REST APIs
			];
		} else if (Array.isArray(rawComps)) {
			this.competitions = rawComps;
		} else {
			this.competitions = rawComps.split(',').map(c => c.trim().toLowerCase());
		}

		this.boxscoreType = options.boxscoreType || 'traditional';
		this.gameSlugs = [];

		// Instantiate available engines
		this.engines = {
			// Continental
			euroleague: new EuroleagueEngine(),
			eurocup: new EuroleagueEngine(),
			bcl: new EuroleagueEngine(),

			// Genius Sports / FIBA LiveStats
			aba: new FibaLiveStatsEngine(),
			lkl: new FibaLiveStatsEngine(),
			gbl: new FibaLiveStatsEngine(),

			// SSR Hydration
			acb: new SsrHydrationEngine(),
			lba: new SsrHydrationEngine(),
			lnb: new SsrHydrationEngine(),

			// REST APIs
			bbl: new DomesticRestEngine(),
			bsl: new DomesticRestEngine(),
			israel: new DomesticRestEngine()
		};

		// Dynamically register any other requested competitions/domestic leagues to share the EuroleagueEngine if not defined
		for (const comp of this.competitions) {
			if (!this.engines[comp]) {
				this.engines[comp] = new EuroleagueEngine();
			}
		}
	}

	/**
	 * @description Fetches slugs across all target competitions for the given season.
	 * @param {string|number} year - The season year (e.g., '2025')
	 * @returns {Promise<EuropeScraper>}
	 */
	async getSeasonGameSlugs(year) {
		const allSlugs = [];

		for (const comp of this.competitions) {
			const engine = this.engines[comp];
			if (engine) {
				console.log(`📡 Fetching slugs for competition [${comp.toUpperCase()}] season [${year}]...`);
				try {
					const slugs = await engine.getSeasonGameSlugs(year, comp);
					allSlugs.push(...slugs);
				} catch (error) {
					console.error(`❌ Failed to fetch slugs for ${comp}:`, error);
				}
			} else {
				console.warn(`⚠️ No engine registered for competition: "${comp}". Skipping.`);
			}
		}

		this.gameSlugs = [...new Set(allSlugs)];
		return this;
	}

	/**
	 * @description Resolves the proper engine based on game ID prefix / competition code.
	 * @param {string} gameId - Game identifier, e.g. 'E25_1', 'ABA25_1001', 'ACB25_2001', or a full slug
	 * @returns {Object} Target engine instance
	 */
	getEngineForGame(gameId) {
		const clean = String(gameId || '').trim().toUpperCase();
		// Extract season code segment (e.g. "ABA25" from "ABA25_1001" or "kkpartizan-vs-kkcrvenazvezda-ABA25_1001")
		const parts = clean.split('_')[0].split('-');
		const seasonCode = parts[parts.length - 1] || 'E25';

		// Extract all alphabet letters from the prefix (e.g. "ABA", "ACB", "BBL")
		const codeLetters = seasonCode.replace(/[^A-Z]/g, '').toLowerCase();

		// Check registered engines
		if (this.engines[codeLetters]) {
			return this.engines[codeLetters];
		}

		// Handle specific legacy/special characters (U -> EuroCup, B -> BCL, E -> EuroLeague)
		const firstChar = seasonCode.charAt(0);
		if (firstChar === 'U') {
			return this.engines.eurocup;
		}
		if (firstChar === 'B') {
			return this.engines.bcl;
		}
		if (firstChar === 'E') {
			return this.engines.euroleague;
		}

		// Fallback to competitionId-based lookup or euroleague
		return this.engines[codeLetters] || this.engines.euroleague;
	}

	/**
	 * @description Returns the API endpoint path.
	 * @param {string} gameId
	 * @returns {string}
	 */
	getGameEndpoint(gameId) {
		return `/game/${gameId}`;
	}

	/**
	 * @description Returns the game URL or identifier string.
	 * @param {string} gameId
	 * @returns {string}
	 */
	getGameUrl(gameId) {
		return gameId;
	}

	/**
	 * @description Overrides the default request runner to delegate to the specific provider engine.
	 * @param {string} url - In our routing, this represents the gameId
	 * @param {Object} [options]
	 * @param {number} [retries]
	 * @param {number} [delay]
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async request(url, options = {}, retries = 3, delay = 1000) {
		const gameId = url;
		const engine = this.getEngineForGame(gameId);
		if (!engine) {
			throw new Error(`No engine found to handle gameId: "${gameId}"`);
		}
		return await engine.getUnifiedBoxScore(gameId);
	}
}
export default EuropeScraper;
