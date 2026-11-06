import path from 'path';

/**
 * @file europe_league_registry.mjs
 * @description Central registry mapping European basketball competitions to their
 * individual league databases. Each European league now gets its own SQLite database
 * file instead of storing everything in a single EUROPE.sqlite.
 *
 * League identifiers are kebab-case strings used for database filenames and
 * the `league` column in stats tables.
 *
 * Competition IDs are the raw `competitionId` values from source boxscore data
 * (e.g. 'euroleague', 'eurocup', 'bcl', 'acb', 'lnb', etc.).
 */

const PROJECT_ROOT = process.cwd();

/**
 * @typedef {Object} EuropeLeagueConfig
 * @property {string} dbFile - SQLite database filename (e.g. 'euroleague.sqlite')
 * @property {string[]} competitions - Competition IDs that route to this league DB
 * @property {string} type - 'continental' or 'domestic'
 */

/**
 * Registry of all European leagues, keyed by league ID.
 * @type {Record<string, EuropeLeagueConfig>}
 */
const EUROPE_LEAGUE_REGISTRY = {
	euroleague: {
		dbFile: 'euroleague.sqlite',
		competitions: ['euroleague'],
		type: 'continental'
	},
	eurocup: {
		dbFile: 'eurocup.sqlite',
		competitions: ['eurocup'],
		type: 'continental'
	},
	basketball_champions_league: {
		dbFile: 'basketball_champions_league.sqlite',
		competitions: ['bcl'],
		type: 'continental'
	},
	fiba_europe_cup: {
		dbFile: 'fiba_europe_cup.sqlite',
		competitions: ['feba', 'fiba_europe_cup', 'fec'],
		type: 'continental'
	},
	acb: {
		dbFile: 'acb.sqlite',
		competitions: ['acb'],
		type: 'domestic'
	},
	greek_basketball: {
		dbFile: 'greek_basketball.sqlite',
		competitions: ['gbl'],
		type: 'domestic'
	},
	italian_serie_a_basketball: {
		dbFile: 'italian_serie_a_basketball.sqlite',
		competitions: ['lba'],
		type: 'domestic'
	},
	french_pro_a: {
		dbFile: 'french_pro_a.sqlite',
		competitions: ['lnb'],
		type: 'domestic'
	},
	german_bbl: {
		dbFile: 'german_bbl.sqlite',
		competitions: ['bbl'],
		type: 'domestic'
	},
	lithuanian_lkl: {
		dbFile: 'lithuanian_lkl.sqlite',
		competitions: ['lkl'],
		type: 'domestic'
	},
	adriatic_basketball: {
		dbFile: 'adriatic_basketball.sqlite',
		competitions: ['aba', 'adriatic'],
		type: 'domestic'
	},
	israeli_basketball: {
		dbFile: 'israeli_basketball.sqlite',
		competitions: ['israel', 'winner_league', 'isl'],
		type: 'domestic'
	},
	bnxt: {
		dbFile: 'bnxt.sqlite',
		competitions: ['bnxt'],
		type: 'domestic'
	},
	finnish_korsiliiga: {
		dbFile: 'finnish_korsiliiga.sqlite',
		competitions: ['korisliiga', 'finnish_korsiliiga'],
		type: 'domestic'
	},
	british_basketball: {
		dbFile: 'british_basketball.sqlite',
		competitions: ['british_basketball', 'bbl_gb', 'basketball_britain'],
		type: 'domestic'
	}
};

/**
 * @description Resolves a competition ID (from raw boxscore data) to its league ID.
 * Falls back to the competition ID itself if no mapping exists.
 * @param {string} competitionId - Raw competition ID from boxscore data
 * @returns {string} The league ID (e.g. 'euroleague', 'acb', 'gbl')
 */
export function resolveLeagueForCompetition(competitionId) {
	if (!competitionId) return 'euroleague';
	const key = String(competitionId).toLowerCase().trim();
	for (const [leagueId, config] of Object.entries(EUROPE_LEAGUE_REGISTRY)) {
		if (config.competitions.includes(key)) {
			return leagueId;
		}
	}
	return key;
}

/**
 * @description Returns the SQLite database file path for a given league ID.
 * @param {string} leagueId - The league identifier
 * @returns {string} Absolute path to the SQLite database file
 */
export function getLeagueDbPath(leagueId) {
	const config = EUROPE_LEAGUE_REGISTRY[leagueId];
	if (!config) {
		throw new Error(`Unknown European league ID: "${leagueId}". Add it to EUROPE_LEAGUE_REGISTRY.`);
	}
	return path.resolve(PROJECT_ROOT, 'data', 'SQL', config.dbFile);
}

/**
 * @description Returns all supported European league IDs.
 * @returns {string[]} Array of league IDs
 */
export function getAllEuropeanLeagueIds() {
	return Object.keys(EUROPE_LEAGUE_REGISTRY);
}

/**
 * @description Returns all competition IDs that map to a given league.
 * @param {string} leagueId - The league identifier
 * @returns {string[]} Array of competition IDs
 */
export function getCompetitionsForLeague(leagueId) {
	const config = EUROPE_LEAGUE_REGISTRY[leagueId];
	return config ? [...config.competitions] : [];
}

/**
 * @description Checks whether a league ID is a supported European league.
 * @param {string} leagueId - The league identifier
 * @returns {boolean}
 */
export function isEuropeanLeague(leagueId) {
	return leagueId in EUROPE_LEAGUE_REGISTRY;
}

export default EUROPE_LEAGUE_REGISTRY;
export { EUROPE_LEAGUE_REGISTRY };