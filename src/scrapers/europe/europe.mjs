import { HTTPClient } from '#utils';
import { EuroleagueEngine } from './engines/EuroleagueEngine.mjs';
import { AcbEngine } from './engines/AcbEngine.mjs';
import { LnbScraper } from './LnbScraper.mjs';
import { LbaScraper } from './LbaScraper.mjs';
import { GblScraper } from './GblScraper.mjs';
import { BblScraper } from './BblScraper.mjs';
import { LklScraper } from './LklScraper.mjs';
import { AbaScraper } from './AbaScraper.mjs';
import { BslScraper } from './BslScraper.mjs';
import { IsraeliScraper } from './IsraeliScraper.mjs';
import { EuroleaguePbpHarvester } from './pbp/EuroleaguePbpHarvester.mjs';
import { AcbPbpHarvester } from './pbp/AcbPbpHarvester.mjs';
import { LnbPbpHarvester } from './pbp/LnbPbpHarvester.mjs';

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

		// Parse competitions list (can be 'all', or comma-separated list like 'euroleague,eurocup,bcl,acb,lnb,lba,gbl')
		const rawComps = options.competitions || 'euroleague';
		if (rawComps === 'all') {
			this.competitions = ['euroleague', 'eurocup', 'bcl', 'acb', 'lnb', 'lba', 'gbl', 'bbl', 'lkl', 'aba', 'bsl', 'israel'];
		} else if (Array.isArray(rawComps)) {
			this.competitions = rawComps;
		} else {
			this.competitions = rawComps.split(',').map(c => c.trim().toLowerCase());
		}

		if (this.competitions.includes('mexico') || this.competitions.includes('lnbp')) {
			throw new Error("Mexico (LNBP) is not a European competition! It must be run under its own solitary league option: --league=mexico");
		}

		this.boxscoreType = options.boxscoreType || 'traditional';
		this.gameSlugs = [];
		this.pbpHarvester = new EuroleaguePbpHarvester(options);
		this.acbPbpHarvester = new AcbPbpHarvester(options);
		this.lnbPbpHarvester = new LnbPbpHarvester(options);

		// Instantiate available engines
		this.engines = {
			euroleague: new EuroleagueEngine(),
			eurocup: new EuroleagueEngine(), // Shared engine for Euroleague API
			bcl: new EuroleagueEngine(),      // Shared engine for BCL API
			acb: new AcbEngine(),
			lnb: new LnbScraper(),
			lba: new LbaScraper(),
			gbl: new GblScraper(),
			bbl: new BblScraper(),
			lkl: new LklScraper(),
			aba: new AbaScraper(),
			bsl: new BslScraper(),
			israel: new IsraeliScraper()
		};

		// Dynamically register any other requested competitions/domestic leagues to share the EuroleagueEngine
		for (const comp of this.competitions) {
			if (!this.engines[comp]) {
				if (comp === 'acb') {
					this.engines[comp] = new AcbEngine();
				} else if (comp === 'lnb') {
					this.engines[comp] = new LnbScraper();
				} else if (comp === 'lba') {
					this.engines[comp] = new LbaScraper();
				} else if (comp === 'gbl') {
					this.engines[comp] = new GblScraper();
				} else if (comp === 'bbl') {
					this.engines[comp] = new BblScraper();
				} else if (comp === 'lkl') {
					this.engines[comp] = new LklScraper();
				} else if (comp === 'aba') {
					this.engines[comp] = new AbaScraper();
				} else if (comp === 'bsl') {
					this.engines[comp] = new BslScraper();
				} else if (comp === 'israel') {
					this.engines[comp] = new IsraeliScraper();
				} else {
					this.engines[comp] = new EuroleagueEngine();
				}
			}
		}
	}

	/**
	 * @description Fetches European play-by-play data using appropriate harvester based on game ID prefix / competition.
	 * @param {string} gameId
	 * @param {string|number} year
	 * @returns {Promise<Object>}
	 */
	async fetchPbp(gameId, year) {
		const clean = String(gameId || '').trim();
		const isAcb = clean.startsWith('A') || clean.includes('_acb_') || this.competitions.includes('acb');
		if (isAcb) {
			return this.acbPbpHarvester.fetchAcbPbp(gameId, year);
		}
		const isLnb = clean.startsWith('L') || clean.includes('_lnb_') || this.competitions.includes('lnb');
		if (isLnb) {
			return this.lnbPbpHarvester.fetchLnbPbp(gameId, year);
		}
		return this.pbpHarvester.fetchEuroleaguePbp(gameId, year);
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
	 * @description Resolves the proper engine based on game ID prefix.
	 * @param {string} gameId - Game identifier, e.g. 'E25_1', 'U25_1', 'B25_1', or a full slug
	 * @returns {Object} Target engine instance
	 */
	getEngineForGame(gameId) {
		const clean = String(gameId || '').trim().toUpperCase();
		// Extract season code segment (e.g. "U25" from "E99_1" or "realmadrid-vs-panathinaikos-U99_1")
		const parts = clean.split('_')[0].split('-');
		const seasonCode = parts[parts.length - 1] || 'E25';
		const firstChar = seasonCode.charAt(0);

		if (firstChar === 'U') {
			return this.engines.eurocup || (this.engines.eurocup = new EuroleagueEngine());
		}
		if (firstChar === 'B') {
			return this.engines.bcl || (this.engines.bcl = new EuroleagueEngine());
		}
		if (firstChar === 'A') {
			return this.engines.acb || (this.engines.acb = new AcbEngine());
		}
		if (firstChar === 'L') {
			return this.engines.lnb || (this.engines.lnb = new LnbScraper());
		}
		if (firstChar === 'I') {
			return this.engines.lba || (this.engines.lba = new LbaScraper());
		}
		if (firstChar === 'G') {
			return this.engines.gbl || (this.engines.gbl = new GblScraper());
		}
		if (firstChar === 'D') {
			return this.engines.bbl || (this.engines.bbl = new BblScraper());
		}
		if (firstChar === 'K') {
			return this.engines.lkl || (this.engines.lkl = new LklScraper());
		}
		if (firstChar === 'V') {
			return this.engines.aba || (this.engines.aba = new AbaScraper());
		}
		if (firstChar === 'S') {
			return this.engines.bsl || (this.engines.bsl = new BslScraper());
		}
		if (firstChar === 'Y') {
			return this.engines.israel || (this.engines.israel = new IsraeliScraper());
		}

		// Fallback to competitionId-based lookup or euroleague
		const competitionId = firstChar.toLowerCase();
		return this.engines[competitionId] || this.engines.euroleague;
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
