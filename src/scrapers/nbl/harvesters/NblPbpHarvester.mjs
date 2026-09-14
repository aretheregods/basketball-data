import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';

/**
 * @description Multi-tier Harvester & Network scraper for NBL Play-By-Play feeds.
 * Targets official NBL Rosetta API endpoints and Genius Sports FIBA LiveStats CDN.
 */
export class NblPbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}]
	 */
	constructor(options = {}) {
		super('https://prod.rosetta.nbl.com.au', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			'accept': 'application/json'
		});
		this.bypassNetwork = options.bypassNetwork ?? (process.env.NODE_ENV === 'test');
		this.seasonMatchCache = {};
	}

	/**
	 * @description Helper to fetch JSON with rate-limiting backoff (HTTP 429 / 5xx)
	 * @param {string} url
	 * @param {Object} [headers={}]
	 * @param {number} [retries=3]
	 * @param {number} [backoffMs=1500]
	 * @returns {Promise<Object|null>}
	 */
	async fetchWithRateLimitBackoff(url, headers = {}, retries = 2, backoffMs = 1500) {
		const reqHeaders = {
			'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			'Accept': 'application/json',
			'Origin': 'https://www.nbl.com.au',
			'Referer': 'https://www.nbl.com.au/',
			...headers
		};

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const res = await fetch(url, { headers: reqHeaders });

				// HTTP 429 Too Many Requests or 5xx server errors retry with backoff
				if (res.status === 429 || res.status >= 500) {
					if (attempt < retries) {
						const delay = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
						console.warn(`⚠️ [NblPbpHarvester] Rate limit/HTTP ${res.status} from ${url}. Backing off for ${delay}ms...`);
						await new Promise(resolve => setTimeout(resolve, delay));
						continue;
					}
				}

				if (res.ok) {
					return await res.json();
				}
			} catch (err) {
				if (attempt < retries) {
					const delay = backoffMs * Math.pow(2, attempt);
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}
		}

		return null;
	}

	/**
	 * @description Extracts clean match ID from game ID slug.
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
	 * @description Fetches raw NBL Play-by-play payload using a multi-tier strategy.
	 * @param {string} gameId - NBL game ID or FIBA match code
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object>} - Raw PBP JSON payload
	 */
	async fetchNblPbp(gameId, year) {
		if (this.bypassNetwork) {
			return this.getMockPbpPayload(gameId);
		}

		const code = this.parseFibaMatchId(gameId);
		const cacheDir = path.resolve(`data/raw/nbl/pbp/${year}`);
		const cachePath = path.join(cacheDir, `${gameId}.json`);

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
			// Cache miss, proceed
		}

		let payload = null;

		// Tier 1: Rosetta Official Live Match Endpoint
		try {
			const rosettaUrl = `https://prod.rosetta.nbl.com.au/get/match/${code}/live/all`;
			const json = await this.fetchWithRateLimitBackoff(rosettaUrl);
			const matchData = Array.isArray(json?.data) ? json.data[0] : json?.data;

			if (matchData) {
				if (Array.isArray(matchData.play_by_play) && matchData.play_by_play.length > 0) {
					payload = { source: 'rosetta_live', data: matchData };
				} else if (matchData.external_media_id && /^\d+$/.test(String(matchData.external_media_id))) {
					// Fallback to Genius Sports FIBA LiveStats CDN using external_media_id extracted from Rosetta match
					const fibaMediaId = String(matchData.external_media_id);
					const fibaUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${fibaMediaId}/data.json`;
					const fibaData = await this.fetchWithRateLimitBackoff(fibaUrl, { Origin: '', Referer: '' });
					if (fibaData && (Array.isArray(fibaData.pbp) || Array.isArray(fibaData.actions))) {
						payload = { source: 'fiba_livestats', data: fibaData };
					}
				}
			}
		} catch (err) {
			console.warn(`⚠️ [NblPbpHarvester] Tier 1 Rosetta fetch failed for Game ID ${gameId}: ${err.message}.`);
		}

		// Tier 2: Direct Genius Sports FIBA LiveStats CDN (if code is numeric)
		if (!payload && /^\d+$/.test(code)) {
			try {
				const fibaUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${code}/data.json`;
				const fibaData = await this.fetchWithRateLimitBackoff(fibaUrl, { Origin: '', Referer: '' });
				if (fibaData && (Array.isArray(fibaData.pbp) || Array.isArray(fibaData.actions))) {
					payload = { source: 'fiba_livestats', data: fibaData };
				}
			} catch (err) {
				console.warn(`⚠️ [NblPbpHarvester] Tier 2 direct FIBA CDN fetch failed for Game ID ${gameId}: ${err.message}.`);
			}
		}

		// Tier 3: Season Matches Index Lookup (resolve legacy Proballers IDs / slugs to Rosetta IDs / external_media_id)
		if (!payload) {
			try {
				let seasonMatches = this.seasonMatchCache[String(year)];
				if (!seasonMatches) {
					const indexUrl = `https://prod.rosetta.nbl.com.au/get/nbl/matches/in/season/${year}/all`;
					const idxJson = await this.fetchWithRateLimitBackoff(indexUrl);
					seasonMatches = Array.isArray(idxJson?.data) ? idxJson.data : [];
					this.seasonMatchCache[String(year)] = seasonMatches;
				}

				if (seasonMatches && seasonMatches.length > 0) {
					const slugClean = String(gameId).toLowerCase().replace(/[^a-z0-9]/g, '');
					let matched = seasonMatches.find(m => m.id === code || String(m.external_media_id) === code);

					if (!matched) {
						matched = seasonMatches.find(m => {
							const mSlug = String(m.match_slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
							const homeName = String(m.home_team?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
							const awayName = String(m.away_team?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

							if (slugClean.includes(mSlug) || mSlug.includes(slugClean)) return true;
							if (homeName && awayName && slugClean.includes(homeName) && slugClean.includes(awayName)) return true;
							return false;
						});
					}

					if (matched) {
						// Try Rosetta Live with matched UUID
						if (matched.id) {
							try {
								const targetUrl = `https://prod.rosetta.nbl.com.au/get/match/${matched.id}/live/all`;
								const json = await this.fetchWithRateLimitBackoff(targetUrl);
								const matchData = Array.isArray(json?.data) ? json.data[0] : json?.data;
								if (matchData && (Array.isArray(matchData.play_by_play) && matchData.play_by_play.length > 0)) {
									payload = { source: 'rosetta_live', data: matchData };
								}
							} catch (e) {}
						}

						// Try FIBA CDN with external_media_id
						if (!payload && matched.external_media_id) {
							try {
								const fibaUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${matched.external_media_id}/data.json`;
								const fibaData = await this.fetchWithRateLimitBackoff(fibaUrl, { Origin: '', Referer: '' });
								if (fibaData && (Array.isArray(fibaData.pbp) || Array.isArray(fibaData.actions))) {
									payload = { source: 'fiba_livestats', data: fibaData };
								}
							} catch (e) {}
						}
					}
				}
			} catch (err) {
				console.warn(`⚠️ [NblPbpHarvester] Tier 3 season match index lookup failed for Game ID ${gameId}: ${err.message}`);
			}
		}

		if (!payload) {
			throw new Error(`No PBP feed available across Rosetta API or FIBA LiveStats for Game ID ${gameId} (code ${code})`);
		}

		try {
			await fs.mkdir(cacheDir, { recursive: true });
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
