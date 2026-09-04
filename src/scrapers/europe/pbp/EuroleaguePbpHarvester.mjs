import fs from 'node:fs/promises';
import path from 'node:path';
import { HTTPClient } from '#utils';

/**
 * @description Harvester for EuroLeague and EuroCup Play-by-Play and Points API endpoints.
 */
export class EuroleaguePbpHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [options={}] - Options
	 */
	constructor(options = {}) {
		super('https://live.euroleague.net/api', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json, text/plain, */*'
		});
		this.bypassNetwork = options.bypassNetwork || false;
	}

	/**
	 * @description Parses competition season code and game code from a gameId slug or string.
	 * Automatically normalizes 2-digit years (e.g. E25 -> E2025).
	 * @param {string} gameId - e.g. 'E2024_1', 'E25_1', 'U2024_15', or 'realmadrid-vs-panathinaikos-E2024_1'
	 * @returns {{ competition: string, seasonCode: string, gameCode: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || '';
		const gameCode = parts[1] || '1';

		const subParts = keyPart.split('-');
		let seasonCode = subParts[subParts.length - 1] || 'E2024';

		const codeChar = seasonCode.toUpperCase().charAt(0);
		let competition = 'euroleague';
		if (codeChar === 'U') {
			competition = 'eurocup';
		} else if (codeChar === 'B') {
			competition = 'bcl';
		}

		// Normalize 2-digit years to full 4-digit season codes (e.g. E25 -> E2025)
		const yearDigits = seasonCode.substring(1);
		if (yearDigits.length === 2) {
			seasonCode = `${codeChar}20${yearDigits}`;
		}

		return {
			competition,
			seasonCode,
			gameCode
		};
	}

	/**
	 * @description Fetches EuroLeague / EuroCup raw play-by-play and points data.
	 * Checks raw cache first, falling back to live HTTP API or test mock payload.
	 *
	 * @param {string} gameId - Game identifier (slug or code)
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object|null>} - Raw play-by-play payload object containing pbp and points
	 */
	async fetchEuroleaguePbp(gameId, year) {
		const { competition, seasonCode, gameCode } = this.parseGameId(gameId);

		const competitionFolder = competition === 'eurocup' ? 'eurocup' : (competition === 'bcl' ? 'bcl' : 'euroleague');
		const cachePath = path.resolve(`data/raw/europe/pbp/${competitionFolder}/${year}/${gameId}.json`);

		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			const parsed = JSON.parse(cached);
			if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
				return parsed;
			}
		} catch (e) {
			// Cache miss, proceed
		}

		const pbpUrl = `https://live.euroleague.net/api/PlaybyPlay?gamecode=${gameCode}&seasoncode=${seasonCode}`;
		const pointsUrl = `https://live.euroleague.net/api/Points?gamecode=${gameCode}&seasoncode=${seasonCode}`;

		let pbpData = null;
		let pointsData = null;

		if (!this.bypassNetwork && process.env.NODE_ENV !== 'test') {
			try {
				const [pbpRes, pointsRes] = await Promise.all([
					this.request(pbpUrl, {}, 3, 2000),
					this.request(pointsUrl, {}, 3, 2000)
				]);

				pbpData = pbpRes;
				pointsData = pointsRes;
			} catch (err) {
				console.warn(`⚠️ [EuroleaguePbpHarvester] Failed fetching Game ${gameId} (${seasonCode}): ${err.message}`);
				return null;
			}
		}

		// Use mock payload in test environments or when bypassNetwork is explicitly set
		if (!pbpData && (process.env.NODE_ENV === 'test' || this.bypassNetwork)) {
			pbpData = {
				Rows: [
					{
						NUMBEROFPLAY: 1,
						PERIOD: 1,
						MINUTE: 1,
						MARKERTIME: "09:45",
						PLAYTYPE: "2FGM",
						TYPE: "Layup",
						TEAM: "RMD",
						PLAYER_ID: "P005432",
						PASSING_PLAYER_ID: "P001234",
						POINTS_A: 2,
						POINTS_B: 0,
						POINTS: 2,
						PLAYINFO: "Campazzo 2pt Layup made"
					},
					{
						NUMBEROFPLAY: 2,
						PERIOD: 1,
						MINUTE: 2,
						MARKERTIME: "09:30",
						PLAYTYPE: "SUB",
						TYPE: "IN",
						TEAM: "PAN",
						PLAYER_ID: "P009999",
						PASSING_PLAYER_ID: null,
						POINTS_A: 2,
						POINTS_B: 0,
						POINTS: 0,
						PLAYINFO: "Sloukas in"
					}
				]
			};
			pointsData = {
				Rows: [
					{
						NUM_ANOT: 1,
						COORD_X: 12.5,
						COORD_Y: 15.0,
						DISTANCE: 2.5
					}
				]
			};
		}

		if (!pbpData) return null;

		return { seasonCode, pbp: pbpData, points: pointsData };
	}
}
