import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseNormalizer } from './BaseNormalizer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

/**
 * @typedef {Object} UnmappedEntities
 * @property {string[]} teams - List of unmapped team names
 * @property {string[]} players - List of unmapped player names
 */

/**
 * @description EuropeanEntityResolver handles team and player entity resolution, mapping various naming conventions to canonical IDs.
 */
export class EuropeanEntityResolver {
	/**
	 * @description Constructor to initialize and load the mapping configurations.
	 * @param {string} [mappingsPath] - Optional custom path for mappings
	 */
	constructor(mappingsPath) {
		const defaultPath = path.resolve(PROJECT_ROOT, 'config/europe_team_mappings.json');
		this.mappingsPath = mappingsPath || defaultPath;
		this.mappings = {};
		this.unmappedPath = path.resolve(PROJECT_ROOT, 'data/unmapped_entities.json');

		this.loadMappings();
	}

	/**
	 * @description Loads team mappings config synchronously.
	 */
	loadMappings() {
		try {
			if (fs.existsSync(this.mappingsPath)) {
				const content = fs.readFileSync(this.mappingsPath, 'utf8');
				const parsed = JSON.parse(content);
				// Standardize keys to uppercase for case-insensitive lookup
				this.mappings = {};
				for (const [key, val] of Object.entries(parsed)) {
					this.mappings[key.toUpperCase().trim()] = val;
				}
			}
		} catch (error) {
			console.error('⚠️ Failed to load European team mappings config:', error);
			this.mappings = {};
		}
	}

	/**
	 * @description Resolves raw team name string to a canonical team ID.
	 * @param {string} rawName - The raw team name
	 * @returns {string} Canonical team ID
	 */
	resolveTeam(rawName) {
		if (typeof rawName !== 'string') {
			return 'unknown-team';
		}

		const cleanedName = BaseNormalizer.cleanString(rawName);
		const upperName = cleanedName.toUpperCase();

		// 1. Check exact match in configured mapping
		if (this.mappings[upperName]) {
			return this.mappings[upperName];
		}

		// 2. Try clean fallback: Strip common European sponsors & suffix variations
		const stripped = this.stripSponsors(cleanedName);
		const slugified = this.slugify(stripped);

		if (slugified) {
			return slugified;
		}

		// 3. Fallback: log to unmapped entities and throw/warn
		this.logUnmappedEntity('teams', rawName);
		throw new Error(`Unresolved team name: "${rawName}". Please add an alias mapping to config/europe_team_mappings.json.`);
	}

	/**
	 * @description Resolves a player name to a canonical player ID.
	 * @param {string} rawName - The raw player name
	 * @returns {string} Canonical player ID
	 */
	resolvePlayer(rawName) {
		if (typeof rawName !== 'string' || !rawName.trim()) {
			return 'unknown-player';
		}

		const normalized = BaseNormalizer.normalizeName(rawName);
		const slugified = this.slugify(normalized);

		if (!slugified) {
			this.logUnmappedEntity('players', rawName);
			throw new Error(`Unresolved player name: "${rawName}". Name cannot be slugified.`);
		}

		return slugified;
	}

	/**
	 * @description Utility to strip common European basketball sponsors, BC/FC suffixes, etc.
	 * @param {string} name - The team name to strip sponsors from
	 * @returns {string} Cleaned team name
	 */
	stripSponsors(name) {
		const sponsorPatterns = [
			/\bAKTOR\b/i, /\bLASSA\b/i, /\bAXA\b/i, /\bBEKO\b/i, /\bBALONCESTO\b/i,
			/\bARMANI\b/i, /\bEXCHANGE\b/i, /\bEMPORIO\b/i, /\bEA7\b/i, /\bOPEL\b/i,
			/\bBC\b/i, /\bFC\b/i, /\bCB\b/i, /\bKK\b/i, /\bCSKA\b/i, /\bREAL\b/i
		];

		let result = name;
		for (const pattern of sponsorPatterns) {
			result = result.replace(pattern, '');
		}
		return BaseNormalizer.cleanString(result);
	}

	/**
	 * @description Utility to slugify a string.
	 * @param {string} text - The input text
	 * @returns {string} Slugified lowercase string
	 */
	slugify(text) {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, '') // Remove special characters
			.trim()
			.replace(/\s+/g, '-');        // Replace spaces with hyphens
	}

	/**
	 * @description Logs unresolved entities to data/unmapped_entities.json file.
	 * @param {'teams'|'players'} category - The category
	 * @param {string} name - Raw name string
	 */
	logUnmappedEntity(category, name) {
		try {
			const dir = path.dirname(this.unmappedPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			/** @type {UnmappedEntities} */
			let data = { teams: [], players: [] };
			if (fs.existsSync(this.unmappedPath)) {
				try {
					data = JSON.parse(fs.readFileSync(this.unmappedPath, 'utf8'));
				} catch (e) {
					// Corrupted file or empty, fallback to empty
				}
			}

			if (!Array.isArray(data.teams)) data.teams = [];
			if (!Array.isArray(data.players)) data.players = [];

			if (category === 'teams' && !data.teams.includes(name)) {
				data.teams.push(name);
			} else if (category === 'players' && !data.players.includes(name)) {
				data.players.push(name);
			}

			fs.writeFileSync(this.unmappedPath, JSON.stringify(data, null, 2), 'utf8');
		} catch (error) {
			console.error('⚠️ Failed to write unmapped entity to audit file:', error);
		}
	}
}
