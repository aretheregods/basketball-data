import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';

/**
 * @description Harvester & Network scraper for NBL FIBA LiveStats Play-By-Play feeds.
 */
export class NblPbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}]
	 */
	constructor(options = {}) {
		super('https://fibalivestats.dcd.shared.geniussports.com', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json'
		});
		this.bypassNetwork = options.bypassNetwork ?? (process.env.NODE_ENV === 'test');
	}

	/**
	 * @description Extracts numeric match ID from NBL game ID slug.
	 * e.g., "melbourne-united-vs-sydney-kings-O2025_10001" -> "10001"
	 * @param {string} gameId
	 * @returns {string}
	 */
	parseFibaMatchId(gameId) {
		const clean = String(gameId || '').trim();
		if (clean.includes('_')) {
			return clean.split('_').pop();
		}
		return clean;
	}

	/**
	 * @description Fetches raw NBL Play-by-play payload for a given game ID from FIBA LiveStats CDN.
	 * @param {string} gameId - NBL game ID or FIBA match code
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object>} - Raw PBP JSON payload
	 */
	async fetchNblPbp(gameId, year) {
		const fibaMatchId = this.parseFibaMatchId(gameId);
		const cachePath = path.resolve(`data/raw/nbl/pbp/${year}/${gameId}.json`);

		// 1. Check local disk cache
		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			if (cached && cached.trim().length > 0) {
				const parsed = JSON.parse(cached);
				if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
					return parsed;
				}
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (this.bypassNetwork) {
			return this.getMockPbpPayload(gameId);
		}

		const url = `https://fibalivestats.dcd.shared.geniussports.com/data/${fibaMatchId}/data.json`;
		let payload = null;

		try {
			const res = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					'Accept': 'application/json'
				}
			});

			if (res.ok) {
				const json = await res.json();
				if (json && typeof json === 'object' && Object.keys(json).length > 0) {
					payload = json;
				}
			}
		} catch (err) {
			console.warn(`⚠️ [NblPbpHarvester] Network fetch failed for Game ID ${gameId} (FIBA ID ${fibaMatchId}): ${err.message}`);
		}

		if (!payload) {
			throw new Error(`Failed to fetch FIBA LiveStats PBP data for Game ID ${gameId}`);
		}

		try {
			await fs.mkdir(path.dirname(cachePath), { recursive: true });
			await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
		} catch (e) {
			// Cache write error ignore
		}

		return payload;
	}

	/**
	 * @description Generates mock play-by-play payload for tests / bypass.
	 * @param {string} gameId
	 * @returns {Object}
	 */
	getMockPbpPayload(gameId) {
		return {
			pbp: [
				{
					actionNumber: 1,
					period: 1,
					gt: "10:00",
					actionType: "period",
					subType: "start",
					text: "Start of 1st Quarter",
					s1: 0,
					s2: 0
				},
				{
					actionNumber: 2,
					period: 1,
					gt: "09:30",
					actionType: "shot",
					subType: "3pt",
					scoring: 1,
					success: 1,
					tno: 1,
					personId: "chris-goulding",
					text: "Chris Goulding 3pt Shot Made",
					s1: 3,
					s2: 0,
					x: 12.5,
					y: 25.0,
					distance: 7.25
				},
				{
					actionNumber: 3,
					period: 1,
					gt: "08:45",
					actionType: "substitution",
					tno: 1,
					personId: "chris-goulding",
					subPersonId: "shea-ili",
					text: "Substitution: Shea Ili in for Chris Goulding",
					s1: 3,
					s2: 0
				},
				{
					actionNumber: 4,
					period: 1,
					gt: "00:00",
					actionType: "period",
					subType: "end",
					text: "End of 1st Quarter",
					s1: 3,
					s2: 0
				}
			]
		};
	}
}

/**
 * Helper function exported for standalone pipeline calls.
 */
export async function fetchNblPbp(gameId, year) {
	const harvester = new NblPbpHarvester();
	return harvester.fetchNblPbp(gameId, year);
}
