import fs from 'fs/promises';
import path from 'path';
import { HTTPClient, validateSchema } from '#utils';

/**
 * @description Harvester & Network scraper for NBA Play-By-Play feeds.
 */
export class NbaPbpHarvester extends HTTPClient {
	/**
	 * @description Creates a harvester with a bounded timeout for each source, including response bodies.
	 * @param {{requestTimeoutMs?: number}} [options={}] - Network configuration.
	 * @throws {RangeError} If the timeout is not a positive integer.
	 */
	constructor(options = {}) {
		super('https://cdn.nba.com', {
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'accept': 'application/json'
		});
		this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
		if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
			throw new RangeError('requestTimeoutMs must be a positive integer');
		}
	}

	/**
	 * @description Fetches and validates one PBP source within a bounded time.
	 * @param {string} url - Source URL.
	 * @param {boolean} [isHtml=false] - Whether to extract PBP from a game webpage.
	 * @returns {Promise<Object>} A non-empty, schema-valid PBP payload.
	 * @throws {Error} If the source times out, fails validation, or has no plays.
	 */
	async fetchSource(url, isHtml = false) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${this.requestTimeoutMs}ms`)), this.requestTimeoutMs);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: {
					...this.defaultHeaders,
					accept: isHtml ? 'text/html' : 'application/json',
					referer: 'https://www.nba.com/',
					origin: 'https://www.nba.com'
				}
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			let payload;
			if (isHtml) {
				const html = await response.text();
				const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
				const nextData = match ? JSON.parse(match[1]) : null;
				const plays = nextData?.props?.pageProps?.playByPlay || nextData?.props?.pageProps?.game?.actions;
				payload = Array.isArray(plays) ? { game: { actions: plays } } : plays;
			} else {
				payload = await response.json();
			}
			validateSchema('nba/pbp.json', payload);
			if (!hasNbaPbpActions(payload)) throw new Error('No play-by-play actions available');
			return payload;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * @description Fetches raw NBA Play-by-play payload for a given game ID with fallback mechanism.
	 * Uses the NBA play-by-play webpage first, with CDN and Stats API fallbacks.
	 * @param {string} gameId - Game ID (e.g. 0022300001)
	 * @param {string|number} year - Season year
	 * @returns {Promise<Object>} - Raw PBP JSON payload
	 * @throws {Error} If every source fails or contains no plays.
	 */
	async fetchNbaPbp(gameId, year) {
		const cleanGameId = String(gameId).trim();
		const cachePath = path.resolve(`data/raw/nba/pbp/${year}/${cleanGameId}.json`);

		try {
			const cached = await fs.readFile(cachePath, 'utf-8');
			if (cached && cached.trim().length > 0) {
				const parsed = JSON.parse(cached);
				validateSchema('nba/pbp.json', parsed);
				if (hasNbaPbpActions(parsed)) return parsed;
			}
		} catch (e) {
			// Cache miss, proceed to network fetch
		}

		const cdnUrl = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${cleanGameId}.json`;
		const statsUrl = `https://stats.nba.com/stats/playbyplayv2?GameID=${cleanGameId}&StartPeriod=0&EndPeriod=14`;

		const gameUrl = `https://www.nba.com/game/${cleanGameId}/play-by-play`;
		const sources = [gameUrl, cdnUrl, statsUrl];
		const failures = [];
		for (const url of sources) {
			try {
				return await this.fetchSource(url, url === gameUrl);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${url}: ${message}`);
				console.warn(`[NbaPbpHarvester] ${cleanGameId}: ${url} failed: ${message}`);
			}
		}
		throw new Error(`All PBP sources failed for ${cleanGameId}: ${failures.join('; ')}`);
	}
}

/**
 * @description Checks for recorded NBA PBP events rather than box-score player statistics.
 * @param {any} payload - Raw NBA PBP payload.
 * @returns {boolean} Whether the payload contains plays.
 */
export function hasNbaPbpActions(payload) {
	const actions = payload?.game?.actions || payload?.game?.plays || payload?.actions || payload?.plays;
	return (Array.isArray(actions) && actions.length > 0) ||
		(Array.isArray(payload?.resultSets) && payload.resultSets.some(
			set => set.name === 'PlayByPlay' && Array.isArray(set.rowSet) && set.rowSet.length > 0
		));
}

/**
 * @description Fetches NBA PBP using the default harvester configuration.
 * @param {string} gameId - NBA game ID.
 * @param {string|number} year - Season year.
 * @returns {Promise<Object>} Raw PBP payload.
 * @throws {Error} If all PBP sources fail.
 */
export async function fetchNbaPbp(gameId, year) {
	const harvester = new NbaPbpHarvester();
	return harvester.fetchNbaPbp(gameId, year);
}
