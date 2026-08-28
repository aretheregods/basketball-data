import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';

/**
 * @description Harvester & Network scraper for NBA Play-By-Play feeds.
 */
export class NbaPbpHarvester extends HTTPClient {
	constructor(options = {}) {
		super('https://cdn.nba.com', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json'
		});
	}

	/**
	 * @description Fetches raw NBA Play-by-play payload for a given game ID with fallback mechanism.
	 * Target CDN live endpoint first, falling back to stats.nba.com playbyplayv2 endpoint and nba.com webpage NEXT_DATA.
	 * @param {string} gameId - Game ID (e.g. 0022300001)
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object>} - Raw PBP JSON payload
	 */
	async fetchNbaPbp(gameId, year) {
		const cleanGameId = String(gameId).trim();
		const cachePath = path.resolve(`data/raw/nba/pbp/${year}/${cleanGameId}.json`);

		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			if (cached && cached.trim().length > 0) {
				const parsed = JSON.parse(cached);
				if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
					return parsed;
				}
			}
		} catch (e) {
			// Cache miss, proceed to network fetch
		}

		const cdnUrl = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${cleanGameId}.json`;
		const statsUrl = `https://stats.nba.com/stats/playbyplayv2?GameID=${cleanGameId}&StartPeriod=0&EndPeriod=14`;

		let payload = null;

		// 1. Primary Attempt: NBA Live CDN API
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
			console.warn(`[NbaPbpHarvester] CDN failed for ${cleanGameId}: ${err.message}. Retrying stats endpoint...`);
		}

		// 2. Secondary Fallback: stats.nba.com API
		if (!payload) {
			try {
				const res = await fetch(statsUrl, {
					headers: {
						'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'accept': 'application/json',
						'referer': 'https://www.nba.com/',
						'origin': 'https://www.nba.com'
					}
				});
				if (res.ok) {
					const json = await res.json();
					if (json && typeof json === 'object' && Object.keys(json).length > 0) {
						payload = json;
					}
				}
			} catch (err) {
				// Fall through to webpage fallback
			}
		}

		// 3. Webpage fallback: fetch game page HTML and parse __NEXT_DATA__
		if (!payload) {
			const gameUrl = `https://www.nba.com/game/${cleanGameId}`;
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
						const pbpData = nextData?.props?.pageProps?.playByPlay || nextData?.props?.pageProps?.game?.actions;
						if (pbpData) {
							payload = Array.isArray(pbpData) ? { game: { actions: pbpData } } : pbpData;
						}
					}
				}
			} catch (err) {
				console.warn(`[NbaPbpHarvester] Webpage extraction failed for ${cleanGameId}: ${err.message}`);
			}
		}

		if (!payload) {
			throw new Error(`HTTP Error on CDN, Stats API, and Webpage fallback for ${cleanGameId}`);
		}

		return payload;
	}
}

/**
 * Helper function exported for standalone pipeline calls.
 */
export async function fetchNbaPbp(gameId, year) {
	const harvester = new NbaPbpHarvester();
	return harvester.fetchNbaPbp(gameId, year);
}
