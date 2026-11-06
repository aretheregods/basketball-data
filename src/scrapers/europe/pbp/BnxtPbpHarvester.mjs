import fs from 'node:fs/promises';
import path from 'node:path';
import { HTTPClient } from '#utils';
import { BnxtHarvester } from '../harvesters/BnxtHarvester.mjs';

/**
 * @description Harvester for BNXT League (Belgium & Netherlands) Play-by-Play data.
 * Implements a multi-tiered ingestion engine targeting Genius Sports FIBA LiveStats CDN endpoints,
 * bnxt.sportpress.info API schedule/game metadata, and test mocking fallbacks.
 */
export class BnxtPbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Harvester options
	 */
	constructor(options = {}) {
		super('https://bnxt.sportpress.info', {
			'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			'accept': 'application/json, text/plain, */*'
		});
		this.bypassNetwork = options.bypassNetwork || false;
		this.apiToken = process.env.BNXT_API_TOKEN || 'BWSyE7sgg9QAurh2JX9cpjzjGc652BWLuNUS';
		this.bnxtHarvester = new BnxtHarvester(this);
	}

	/**
	 * @description Parses game code and season year from a BNXT game ID.
	 * Formats:
	 *  - filou-oostende-vs-spirou-basket-N2024_7161
	 *  - N2024_7161
	 *  - 7161
	 * @param {string} gameId
	 * @param {string|number} [defaultYear='2024']
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, seasonYear: string }}
	 */
	parseGameId(gameId, defaultYear = '2024') {
		const clean = String(gameId || '').trim();
		let gameCode = clean;
		let seasonYear = String(defaultYear);

		if (clean.includes('_')) {
			const parts = clean.split('_');
			const keyPart = parts[0] || 'N2024';
			gameCode = parts[1] || '1';

			const match = keyPart.match(/(?:-)?N(\d{4})$/i);
			if (match) {
				seasonYear = match[1];
			} else if (keyPart.startsWith('N')) {
				seasonYear = keyPart.substring(1);
			}
		} else if (clean.includes('-')) {
			const parts = clean.split('-');
			const lastPart = parts[parts.length - 1];
			if (lastPart.includes('_')) {
				return this.parseGameId(lastPart, defaultYear);
			}
		}

		return {
			competitionId: `BNXT${seasonYear}`,
			seasonCode: `BNXT${seasonYear}`,
			gameCode,
			seasonYear
		};
	}

	/**
	 * @description Fetches BNXT raw play-by-play data using multi-tier retrieval.
	 * Checks local disk cache first, then attempts FIBA LiveStats / Genius Sports via genius_id,
	 * or falls back to mock/empty payloads.
	 *
	 * @param {string} gameId - Game identifier
	 * @param {string|number} [seasonYear='2024'] - Season year
	 * @param {string|number} [geniusMatchId=null] - Optional genius_id / FIBA match ID
	 * @returns {Promise<Object>} Raw play-by-play payload
	 */
	async fetchBnxtPbp(gameId, seasonYear = '2024', geniusMatchId = null) {
		const { competitionId, gameCode, seasonYear: year } = this.parseGameId(gameId, seasonYear);
		const targetFolder = String(year).startsWith('N') ? year.substring(1) : year;
		const cachePath = path.resolve(`data/raw/europe/pbp/bnxt/${targetFolder}/${gameId}.json`);

		// 1. Check local disk cache
		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			const parsed = JSON.parse(cached);
			if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
				if (Array.isArray(parsed.actions) || Array.isArray(parsed.events) || parsed.data || parsed.pbp) {
					return parsed;
				}
			}
		} catch (e) {
			// Cache miss or invalid JSON, proceed
		}

		let payload = null;

		if (!this.bypassNetwork && process.env.NODE_ENV !== 'test') {
			let targetGeniusId = geniusMatchId;

			// If geniusMatchId not provided, query schedule/find endpoint or schedule/game-slider
			if (!targetGeniusId) {
				try {
					const headers = {
						'X-Authorization': this.apiToken,
						'Content-Type': 'application/json',
						'X-Localization': 'en'
					};
					const schedRes = await fetch(`https://bnxt.sportpress.info/api/v1/schedule/find/${gameCode}?lang=en`, { headers });
					if (schedRes.ok) {
						const schedJson = await schedRes.json();
						if (schedJson.data?.genius_id) {
							targetGeniusId = schedJson.data.genius_id;
						}
					}
				} catch (err) {
					console.warn(`⚠️ [BnxtPbpHarvester] Failed to look up genius_id for game ${gameCode}: ${err.message}`);
				}
			}

			// Tier 1: Genius Sports / FIBA LiveStats CDN
			if (targetGeniusId) {
				try {
					const fibaUrl = `https://fibalivestats.dcd.shared.geniussports.com/data/${targetGeniusId}/data.json`;
					const fibaRes = await fetch(fibaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
					if (fibaRes.ok) {
						const fibaData = await fibaRes.json();
						if (fibaData && (fibaData.pbp || fibaData.tm)) {
							payload = {
								gameId: String(gameId),
								competitionId,
								seasonYear: year,
								source: 'fiba_livestats',
								geniusId: targetGeniusId,
								data: fibaData
							};
						}
					}
				} catch (err) {
					console.warn(`⚠️ [BnxtPbpHarvester] Tier 1 FIBA CDN fetch failed for BNXT Game ${gameId}: ${err.message}`);
				}
			}
		}

		// Mock payload in test mode or when bypassNetwork is set
		if (!payload && (process.env.NODE_ENV === 'test' || this.bypassNetwork)) {
			payload = {
				gameId: String(gameId),
				competitionId,
				seasonYear: year,
				source: 'mock',
				actions: [
					{
						id: 1,
						period: 1,
						gameTime: "00:09:40",
						type: "THREE_POINT_MADE",
						isSuccessful: true,
						teamId: "OOS",
						playerId: "p-243",
						homeScore: 3,
						awayScore: 0,
						description: "Pierre-Antoine Gillet 3pt jump shot made"
					},
					{
						id: 2,
						period: 1,
						gameTime: "00:09:20",
						type: "SUBSTITUTION",
						teamId: "CHA",
						playerId: "p-301",
						subType: "IN",
						homeScore: 3,
						awayScore: 0,
						description: "Substitution: Milan Samardzic in"
					}
				]
			};
		}

		// Fail-soft empty payload fallback
		if (!payload) {
			payload = {
				gameId: String(gameId),
				competitionId,
				seasonYear: year,
				actions: []
			};
		}

		// Save payload to disk cache
		try {
			await fs.mkdir(path.dirname(cachePath), { recursive: true });
			await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
		} catch (e) {
			// Ignore write errors
		}

		return payload;
	}
}

export default BnxtPbpHarvester;
