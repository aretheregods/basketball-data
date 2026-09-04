import fs from 'node:fs/promises';
import path from 'node:path';
import { HTTPClient } from '#utils';

/**
 * @description Harvester for Spanish Liga ACB Play-by-Play API endpoints.
 */
export class AcbPbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Options
	 */
	constructor(options = {}) {
		super('https://live.acb.com', {
			'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			'accept': 'application/json, text/plain, */*',
			'referer': 'https://live.acb.com/'
		});
		this.bypassNetwork = options.bypassNetwork || false;
	}

	/**
	 * @description Parses game code and season year from an ACB game ID.
	 * ACB game ID is formatted as A{season}_{numeric_id}, e.g. A2025_105373 or 105373.
	 * @param {string} gameId
	 * @param {string|number} [defaultYear='2025']
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, seasonYear: string }}
	 */
	parseGameId(gameId, defaultYear = '2025') {
		const clean = String(gameId || '').trim();
		let gameCode = clean;
		let seasonYear = String(defaultYear);

		if (clean.includes('_')) {
			const parts = clean.split('_');
			const keyPart = parts[0] || 'A2025';
			gameCode = parts[1] || '1';
			seasonYear = keyPart.startsWith('A') ? keyPart.substring(1) : keyPart;
		} else if (clean.includes('-')) {
			const parts = clean.split('-');
			const lastPart = parts[parts.length - 1];
			if (lastPart.includes('_')) {
				return this.parseGameId(lastPart, defaultYear);
			}
		}

		return {
			competitionId: `ACB${seasonYear}`,
			seasonCode: `ACB${seasonYear}`,
			gameCode,
			seasonYear
		};
	}

	/**
	 * @description Fetches Spanish ACB raw play-by-play data.
	 * Checks raw disk cache first, falling back to live HTTP API or test mock payload.
	 *
	 * @param {string} gameId - Game identifier
	 * @param {string|number} seasonYear - Season year (e.g. 2025)
	 * @returns {Promise<Object|null>} - Raw play-by-play payload object
	 */
	async fetchAcbPbp(gameId, seasonYear = '2025') {
		const { competitionId, gameCode, seasonYear: year } = this.parseGameId(gameId, seasonYear);
		const targetFolder = String(year).startsWith('A') ? year.substring(1) : year;
		const cachePath = path.resolve(`data/raw/europe/pbp/acb/${targetFolder}/${gameId}.json`);

		// Disk cache check
		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			const parsed = JSON.parse(cached);
			if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
				return parsed;
			}
		} catch (e) {
			// Cache miss or invalid JSON, proceed
		}

		const apiUrl = `https://live.acb.com/api/v1/partidos/${gameCode}/jugadas`;
		let payload = null;

		if (!this.bypassNetwork && process.env.NODE_ENV !== 'test') {
			try {
				payload = await this.request(apiUrl, {}, 3, 2000);
			} catch (err) {
				console.warn(`⚠️ [AcbPbpHarvester] Failed fetching PBP for ACB Game ${gameId} (${year}): ${err.message}`);
				return null;
			}
		}

		// Use mock payload in test environments or when bypassNetwork is explicitly set
		if (!payload && (process.env.NODE_ENV === 'test' || this.bypassNetwork)) {
			payload = {
				gameId: String(gameId),
				competitionId,
				seasonYear: year,
				jugadas: [
					{
						id: 1,
						periodo: 1,
						tiempo: "09:45",
						tipo: "2FGM",
						subtipo: "Mate",
						texto: "Canasta de 2 puntos de Kevin Punter",
						idEquipo: "BAR",
						idJugador: "30003361",
						puntosLocal: 2,
						puntosVisitante: 0,
						posX: 12.5,
						posY: 15.0,
						distancia: 2.5
					},
					{
						id: 2,
						periodo: 1,
						tiempo: "09:30",
						tipo: "SUB",
						subtipo: "IN",
						texto: "Cambio: Entra Jean Montero",
						idEquipo: "VBC",
						idJugador: "30002844",
						puntosLocal: 2,
						puntosVisitante: 0
					}
				]
			};
		}

		if (payload) {
			try {
				await fs.mkdir(path.dirname(cachePath), { recursive: true });
				await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
			} catch (e) {
				// Ignore write errors if in strict mock test modes
			}
		}

		return payload;
	}
}
