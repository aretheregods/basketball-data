import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';

/**
 * @description Multi-tier Harvester & Network scraper for NBL Play-By-Play feeds.
 * Supports NBL Microservice REST API (Tier 1), Webflow Page Hydration State (Tier 2),
 * and Genius Sports FIBA LiveStats CDN (Tier 3).
 */
export class NblPbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}]
	 */
	constructor(options = {}) {
		super('https://prod.nbl.com.au', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
	 * @description Fetches raw NBL Play-by-play payload using a multi-tier strategy.
	 * @param {string} gameId - NBL game ID or FIBA match code
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object>} - Raw PBP JSON payload
	 */
	async fetchNblPbp(gameId, year) {
		const fibaMatchId = this.parseFibaMatchId(gameId);
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

		if (this.bypassNetwork) {
			return this.getMockPbpPayload(gameId);
		}

		let payload = null;

		// Tier 1: NBL Microservice REST Endpoint
		try {
			const apiUrls = [
				`https://prod.nbl.com.au/api/v1/matches/${gameId}/pbp`,
				`https://prod.nbl.com.au/api/v1/games/${gameId}/pbp`,
				`https://api.nbl.com.au/v1/games/${gameId}/play-by-play`
			];

			for (const url of apiUrls) {
				const res = await fetch(url, {
					headers: {
						'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
						'Accept': 'application/json'
					}
				});

				if (res.ok) {
					const data = await res.json();
					if (data && (Array.isArray(data.actions) || Array.isArray(data.plays) || Array.isArray(data.pbp) || Array.isArray(data))) {
						payload = { source: 'nbl_api', data };
						break;
					}
				}
			}
		} catch (err) {
			console.warn(`⚠️ [NblPbpHarvester] Tier 1 API fetch failed for Game ID ${gameId}: ${err.message}. Fallback to Tier 2...`);
		}

		// Tier 2: Fetch Webflow Game Page HTML & Extract Embedded Hydration State or DOM
		if (!payload) {
			try {
				const webflowUrls = [
					`https://www.nbl.com.au/games/${gameId}`,
					`https://www.nbl.com.au/match-center/${gameId}`
				];

				for (const url of webflowUrls) {
					const res = await fetch(url, {
						headers: {
							'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
							'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
						}
					});

					if (res.ok) {
						const html = await res.text();

						// Check for embedded JSON state script tags (__NEXT_DATA__, __NBL_STATE__, initialData)
						const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
						if (nextDataMatch) {
							try {
								const nextData = JSON.parse(nextDataMatch[1]);
								const pageProps = nextData?.props?.pageProps;
								if (pageProps && (pageProps.pbp || pageProps.actions || pageProps.game?.actions)) {
									payload = { source: 'webflow_state', data: pageProps };
									break;
								}
							} catch (e) {}
						}

						const stateMatch = html.match(/(?:__NBL_STATE__|initialData)\s*=\s*({.*?});/s);
						if (stateMatch) {
							try {
								const stateData = JSON.parse(stateMatch[1]);
								if (stateData && (stateData.actions || stateData.pbp || stateData.events)) {
									payload = { source: 'webflow_state', data: stateData };
									break;
								}
							} catch (e) {}
						}

						// Fallback: DOM Extraction via regex matching on table rows
						const domActions = [];
						const rowRegex = /<tr[^>]*class="[^"]*(?:pbp|event|match)[^"]*"[^>]*>(.*?)<\/tr>/gis;
						let rowMatch;
						let idx = 0;
						while ((rowMatch = rowRegex.exec(html)) !== null) {
							const rowInner = rowMatch[1];
							const timeMatch = rowInner.match(/class="[^"]*(?:time|clock)[^"]*"[^>]*>(.*?)<\//i);
							const scoreMatch = rowInner.match(/class="[^"]*score[^"]*"[^>]*>(.*?)<\//i);
							const descMatch = rowInner.match(/class="[^"]*(?:description|text)[^"]*"[^>]*>(.*?)<\//i);
							const teamMatch = rowInner.match(/class="[^"]*team[^"]*"[^>]*>(.*?)<\//i);

							const time = timeMatch ? timeMatch[1].replace(/<[^>]+>/g, '').trim() : '';
							const score = scoreMatch ? scoreMatch[1].replace(/<[^>]+>/g, '').trim() : '';
							const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';
							const team = teamMatch ? teamMatch[1].replace(/<[^>]+>/g, '').trim() : '';

							if (desc || time) {
								domActions.push({ index: idx++, time, score, desc, team });
							}
						}

						if (domActions.length > 0) {
							payload = { source: 'html_dom', data: domActions };
							break;
						}
					}
				}
			} catch (err) {
				console.warn(`⚠️ [NblPbpHarvester] Tier 2 Webflow scrape failed for Game ID ${gameId}: ${err.message}. Fallback to Tier 3...`);
			}
		}

		// Tier 3: Genius Sports / FIBA LiveStats CDN Fallback
		if (!payload && fibaMatchId) {
			try {
				const fibaUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${fibaMatchId}/data.json`;
				const res = await fetch(fibaUrl, {
					headers: {
						'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
						'Accept': 'application/json'
					}
				});

				if (res.ok) {
					const fibaData = await res.json();
					if (fibaData && (fibaData.pbp || fibaData.actions)) {
						payload = fibaData;
					}
				}
			} catch (err) {
				console.warn(`⚠️ [NblPbpHarvester] Tier 3 FIBA LiveStats CDN fetch failed for Game ID ${gameId} (FIBA ID ${fibaMatchId}): ${err.message}`);
			}
		}

		if (!payload) {
			throw new Error(`No PBP feed available across Tier 1, Tier 2, or Tier 3 for Game ID ${gameId} (FIBA ID ${fibaMatchId})`);
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
