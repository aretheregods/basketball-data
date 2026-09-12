import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';

/**
 * @description Multi-tier Harvester & Network scraper for NBL Play-By-Play feeds.
 * Targets official NBL Rosetta API endpoints, Genius Sports FIBA LiveStats CDN,
 * and dynamic game resolution for legacy slugs.
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

		let payload = null;

		// Tier 1: Rosetta Official Live Match Endpoint
		try {
			const rosettaUrl = `https://prod.rosetta.nbl.com.au/get/match/${fibaMatchId}/live/all`;
			const res = await fetch(rosettaUrl, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					'Accept': 'application/json',
					'Origin': 'https://www.nbl.com.au',
					'Referer': 'https://www.nbl.com.au/'
				}
			});

			if (res.ok) {
				const json = await res.json();
				const matchData = Array.isArray(json?.data) ? json.data[0] : json?.data;
				if (matchData && (Array.isArray(matchData.play_by_play) && matchData.play_by_play.length > 0)) {
					payload = { source: 'rosetta_live', data: matchData };
				}
			}
		} catch (err) {
			console.warn(`⚠️ [NblPbpHarvester] Tier 1 Rosetta Live fetch failed for Game ID ${gameId}: ${err.message}. Trying Tier 2...`);
		}

		// Tier 2: Genius Sports FIBA LiveStats CDN Fallback
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
					if (fibaData && (Array.isArray(fibaData.pbp) || Array.isArray(fibaData.actions))) {
						payload = { source: 'fiba_livestats', data: fibaData };
					}
				}
			} catch (err) {
				console.warn(`⚠️ [NblPbpHarvester] Tier 2 FIBA LiveStats CDN fetch failed for Game ID ${gameId}: ${err.message}. Trying Tier 3...`);
			}
		}

		// Tier 3: Season Matches Index Lookup (Mapping legacy Proballers IDs / slugs to Rosetta IDs / external_media_id)
		if (!payload) {
			try {
				let seasonMatches = this.seasonMatchCache[String(year)];
				if (!seasonMatches) {
					const indexUrl = `https://prod.rosetta.nbl.com.au/get/nbl/matches/in/season/${year}/all`;
					const idxRes = await fetch(indexUrl, {
						headers: {
							'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
							'Accept': 'application/json',
							'Origin': 'https://www.nbl.com.au',
							'Referer': 'https://www.nbl.com.au/'
						}
					});

					if (idxRes.ok) {
						const idxJson = await idxRes.json();
						seasonMatches = Array.isArray(idxJson?.data) ? idxJson.data : [];
						this.seasonMatchCache[String(year)] = seasonMatches;
					}
				}

				if (seasonMatches && seasonMatches.length > 0) {
					const slugClean = String(gameId).toLowerCase().replace(/[^a-z0-9]/g, '');
					let matched = seasonMatches.find(m => m.id === fibaMatchId || m.external_media_id === fibaMatchId);

					if (!matched) {
						// Match by team names or slug fragments
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
						const targetIds = [matched.id, matched.external_media_id].filter(Boolean);
						for (const targetId of targetIds) {
							// Try Rosetta Live first
							try {
								const targetUrl = `https://prod.rosetta.nbl.com.au/get/match/${targetId}/live/all`;
								const res = await fetch(targetUrl, {
									headers: {
										'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
										'Accept': 'application/json',
										'Origin': 'https://www.nbl.com.au',
										'Referer': 'https://www.nbl.com.au/'
									}
								});
								if (res.ok) {
									const json = await res.json();
									const matchData = Array.isArray(json?.data) ? json.data[0] : json?.data;
									if (matchData && (Array.isArray(matchData.play_by_play) && matchData.play_by_play.length > 0)) {
										payload = { source: 'rosetta_live', data: matchData };
										break;
									}
								}
							} catch (e) {}

							// Try FIBA CDN
							try {
								const fibaUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${targetId}/data.json`;
								const res = await fetch(fibaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
								if (res.ok) {
									const fibaData = await res.json();
									if (fibaData && (Array.isArray(fibaData.pbp) || Array.isArray(fibaData.actions))) {
										payload = { source: 'fiba_livestats', data: fibaData };
										break;
									}
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
