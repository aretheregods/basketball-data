import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';

/**
 * @description Harvester & Network scraper for WNBA Play-By-Play feeds.
 */
export class WnbaPbpHarvester extends HTTPClient {
	constructor(options = {}) {
		super('https://cdn.wnba.com', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json'
		});
	}

	/**
	 * @description Fetches raw WNBA Play-by-play payload for a given game ID with fallback mechanism.
	 * Target CDN live endpoint first, falling back to stats.wnba.com playbyplayv2 endpoint.
	 * @param {string} gameId - 10-digit game ID
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object>} - Raw PBP JSON payload
	 */
	async fetchWnbaPbp(gameId, year) {
		// Normalize 10-digit game IDs starting with '10' (from mobile schedule format '1042100313') to '00' (standard Stats API format '0042100313')
		let normalizedGameId = String(gameId).trim();
		if (normalizedGameId.startsWith('10') && normalizedGameId.length === 10) {
			normalizedGameId = '00' + normalizedGameId.substring(2);
		}

		const cachePath = path.resolve(`data/raw/wnba/pbp/${year}/${gameId}.json`);

		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			if (cached && cached.trim().length > 0) {
				return JSON.parse(cached);
			}
		} catch (e) {
			// Cache miss, proceed to network fetch
		}

		const cdnUrl = `https://cdn.wnba.com/static/json/liveData/playbyplay/playbyplay_${normalizedGameId}.json`;
		const statsUrl = `https://stats.wnba.com/stats/playbyplayv2?GameID=${normalizedGameId}&StartPeriod=0&EndPeriod=14`;

		let payload = null;

		try {
			const res = await fetch(cdnUrl, {
				headers: {
					'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'accept': 'application/json'
				}
			});
			if (res.ok) {
				const json = await res.json();
				if (json && typeof json === 'object' && Object.keys(json).length > 0) {
					payload = json;
				}
			}
		} catch (err) {
			console.warn(`[WnbaPbp] CDN failed for ${gameId}: ${err.message}. Retrying stats endpoint...`);
		}

		if (!payload) {
			try {
				const res = await fetch(statsUrl, {
					headers: {
						'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'accept': 'application/json',
						'referer': 'https://www.wnba.com/',
						'origin': 'https://www.wnba.com'
					}
				});
				if (res.ok) {
					const json = await res.json();
					if (json && typeof json === 'object' && Object.keys(json).length > 0) {
						payload = json;
					}
				}
			} catch (err) {
				// Fall through to HTML webpage extraction
			}
		}

		// Webpage fallback: fetch game page HTML and parse __NEXT_DATA__
		if (!payload) {
			const gameUrl = `https://www.wnba.com/game/${normalizedGameId}`;
			try {
				const res = await fetch(gameUrl, {
					headers: {
						'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
					}
				});
				if (res.ok) {
					const html = await res.text();
					const match = html.match(/<script id=\"__NEXT_DATA__\" type=\"application\/json\">(.*?)<\/script>/s);
					if (match) {
						const nextData = JSON.parse(match[1]);
						const pbpData = nextData?.props?.pageProps?.playByPlay;
						if (pbpData) {
							payload = pbpData;
						}
					}
				}
			} catch (err) {
				console.warn(`[WnbaPbp] Webpage extraction failed for ${gameId}: ${err.message}`);
			}
		}

		if (!payload) {
			throw new Error(`HTTP Error on CDN, Stats API, and Webpage fallback for ${gameId}`);
		}

		return payload;
	}
}

/**
 * Helper function exported for standalone pipeline calls.
 */
export async function fetchWnbaPbp(gameId, year) {
	const harvester = new WnbaPbpHarvester();
	return harvester.fetchWnbaPbp(gameId, year);
}
