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
import { LbaPbpHarvester } from './pbp/LbaPbpHarvester.mjs';
import { GblPbpHarvester } from './pbp/GblPbpHarvester.mjs';
import { BblPbpHarvester } from './pbp/BblPbpHarvester.mjs';
import { LklPbpHarvester } from './pbp/LklPbpHarvester.mjs';
import { AbaPbpHarvester } from './pbp/AbaPbpHarvester.mjs';

/**
 * @description Extracts the competition prefix letter from a European game ID slug.
 * @param {string} gameId
 * @returns {string} Single uppercase letter prefix (e.g. 'V' for ABA, 'A' for ACB, 'E' for EuroLeague)
 */
export function getEuropeGamePrefix(gameId) {
	const clean = String(gameId || '').trim().toUpperCase();
	if (!clean) return 'E';
	const parts = clean.split('_')[0].split('-');
	const seasonCode = parts[parts.length - 1] || 'E2025';
	return seasonCode.charAt(0);
}

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
		const rawComps = options.competitions || options.competition || 'euroleague';
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
		this.lbaPbpHarvester = new LbaPbpHarvester(options);
		this.gblPbpHarvester = new GblPbpHarvester(options);
		this.bblPbpHarvester = new BblPbpHarvester(options);
		this.lklPbpHarvester = new LklPbpHarvester(options);
		this.abaPbpHarvester = new AbaPbpHarvester(options);

		const engineOptions = { ...options };

		// Instantiate available engines
		this.engines = {
			euroleague: new EuroleagueEngine(engineOptions),
			eurocup: new EuroleagueEngine(engineOptions), // Shared engine for Euroleague API
			bcl: new EuroleagueEngine(engineOptions),      // Shared engine for BCL API
			acb: new AcbEngine(engineOptions),
			lnb: new LnbScraper(engineOptions),
			lba: new LbaScraper(engineOptions),
			gbl: new GblScraper(engineOptions),
			bbl: new BblScraper(engineOptions),
			lkl: new LklScraper(engineOptions),
			aba: new AbaScraper(engineOptions),
			bsl: new BslScraper(engineOptions),
			israel: new IsraeliScraper(engineOptions)
		};

		// Dynamically register any other requested competitions/domestic leagues to share the EuroleagueEngine
		for (const comp of this.competitions) {
			if (!this.engines[comp]) {
				if (comp === 'acb') {
					this.engines[comp] = new AcbEngine(engineOptions);
				} else if (comp === 'lnb') {
					this.engines[comp] = new LnbScraper(engineOptions);
				} else if (comp === 'lba') {
					this.engines[comp] = new LbaScraper(engineOptions);
				} else if (comp === 'gbl') {
					this.engines[comp] = new GblScraper(engineOptions);
				} else if (comp === 'bbl') {
					this.engines[comp] = new BblScraper(engineOptions);
				} else if (comp === 'lkl') {
					this.engines[comp] = new LklScraper(engineOptions);
				} else if (comp === 'aba') {
					this.engines[comp] = new AbaScraper(engineOptions);
				} else if (comp === 'bsl') {
					this.engines[comp] = new BslScraper(engineOptions);
				} else if (comp === 'israel') {
					this.engines[comp] = new IsraeliScraper(engineOptions);
				} else {
					this.engines[comp] = new EuroleagueEngine(engineOptions);
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
		const prefix = getEuropeGamePrefix(clean);
		const compOption = (this.competitions.length === 1 ? this.competitions[0] : '').toLowerCase();

		if (prefix === 'A' || clean.includes('_acb_') || compOption === 'acb') {
			return this.acbPbpHarvester.fetchAcbPbp(gameId, year);
		}
		if (prefix === 'L' || clean.includes('_lnb_') || compOption === 'lnb') {
			return this.lnbPbpHarvester.fetchLnbPbp(gameId, year);
		}
		if (prefix === 'I' || clean.includes('_lba_') || compOption === 'lba') {
			return this.lbaPbpHarvester.fetchLbaPbp(gameId, year);
		}
		if (prefix === 'G' || clean.includes('_gbl_') || compOption === 'gbl') {
			return this.gblPbpHarvester.fetchGblPbp(gameId, year);
		}
		if (prefix === 'D' || clean.includes('_bbl_') || compOption === 'bbl') {
			return this.bblPbpHarvester.fetchBblPbp(gameId, year);
		}
		if (prefix === 'K' || clean.includes('_lkl_') || compOption === 'lkl') {
			return this.lklPbpHarvester.fetchLklPbp(gameId, year);
		}
		if (prefix === 'V' || clean.includes('_aba_') || compOption === 'aba') {
			return this.abaPbpHarvester.fetchAbaPbp(gameId, year);
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
