/**
 * @file BnxtPortalSchedule.mjs
 * @description Reads the public BNXT Portal schedule as a fallback to Sportpress.
 */

const PORTAL_SCHEDULE_URL = 'https://bnxtportal.com/wedstrijden';

/**
 * @typedef {Object} BnxtPortalGame
 * @property {string} date - ISO calendar date.
 * @property {string} [time] - Local tip-off time.
 * @property {string} home_team - Home team name.
 * @property {string} away_team - Away team name.
 * @property {number|string|null} [external_id] - BNXT/Sportpress game identifier.
 * @property {number|string|null} [genius_id] - Genius LiveStats match identifier.
 * @property {string} [status] - Portal status label.
 * @property {string} [url] - Portal match URL containing its portal game identifier.
 * @property {number|null} [home_score] - Home final score, when played.
 * @property {number|null} [away_score] - Away final score, when played.
 */

/**
 * @description Decodes HTML entities used in the schedule's Alpine.js JSON attribute.
 * @param {string} value - HTML-encoded string.
 * @returns {string} Decoded string.
 */
function decodeHtmlAttribute(value) {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&#x27;/gi, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ');
}

/**
 * @description Extracts schedule entries from the portal's embedded matchFilters JSON.
 * @param {string} html - BNXT Portal schedule HTML.
 * @returns {BnxtPortalGame[]} Parsed schedule entries.
 * @throws {Error} Throws if the expected embedded schedule is missing or invalid.
 */
export function parseBnxtPortalSchedule(html) {
	const match = String(html || '').match(/x-data="matchFilters\(([\s\S]*?)\)"/);
	if (!match) throw new Error('BNXT Portal page does not contain an embedded match schedule');
	let games;
	try {
		games = JSON.parse(decodeHtmlAttribute(match[1]));
	} catch (error) {
		throw new Error(`Could not parse BNXT Portal schedule JSON: ${error.message}`);
	}
	if (!Array.isArray(games)) throw new Error('BNXT Portal schedule payload is not an array');
	return games.filter(game => game && typeof game === 'object' && game.date && game.home_team && game.away_team);
}

/**
 * @description Maps a portal game date to the BNXT season's end year.
 * BNXT seasons begin in autumn and end in spring.
 * @param {string} isoDate - Game date in YYYY-MM-DD format.
 * @returns {number} BNXT season end year.
 */
export function getBnxtSeasonEndYear(isoDate) {
	const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-/);
	if (!match) return NaN;
	const year = Number(match[1]);
	const month = Number(match[2]);
	return month >= 7 ? year + 1 : year;
}

/**
 * @description Fetches and filters public BNXT Portal fixtures for a BNXT end-year season.
 * @param {string|number} seasonEndYear - Season end year, e.g. 2027 for 2026–27.
 * @param {typeof fetch} [fetchImpl=fetch] - Fetch implementation, injectable for tests.
 * @returns {Promise<BnxtPortalGame[]>} Games belonging to the requested season.
 * @throws {Error} Throws on HTTP errors or invalid page data.
 */
export async function fetchBnxtPortalSchedule(seasonEndYear, fetchImpl = fetch) {
	const response = await fetchImpl(PORTAL_SCHEDULE_URL, {
		headers: {
			'User-Agent': 'Mozilla/5.0',
			Accept: 'text/html,application/xhtml+xml'
		}
	});
	if (!response.ok) throw new Error(`BNXT Portal schedule request failed: HTTP ${response.status}`);
	const games = parseBnxtPortalSchedule(await response.text());
	const targetSeason = Number(seasonEndYear);
	return games.filter(game => getBnxtSeasonEndYear(game.date) === targetSeason);
}

/**
 * @description Creates the repository's standard BNXT game slug from a portal game.
 * @param {BnxtPortalGame} game - Source schedule entry.
 * @param {string|number} seasonEndYear - BNXT season end year.
 * @returns {{ slug: string, gameId: string, geniusMatchId: string|null }} Slug and source IDs.
 */
export function mapBnxtPortalGame(game, seasonEndYear) {
	const slugify = (value) => String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/[\s-]+/g, '-');
	const portalGameId = String(game.url || '').match(/\/wedstrijden\/(\d+)\//)?.[1];
	const gameId = String(game.external_id || portalGameId || '');
	if (!/^\d+$/.test(gameId)) throw new Error(`BNXT Portal game has no usable game identifier: ${game.url || game.date}`);
	return {
		slug: `${slugify(game.home_team)}-vs-${slugify(game.away_team)}-N${seasonEndYear}_${gameId}`,
		gameId,
		geniusMatchId: game.genius_id ? String(game.genius_id) : null
	};
}

export default fetchBnxtPortalSchedule;
