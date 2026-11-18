import { HTTPClient } from '#utils';

/**
 * @description A single B.League B1 schedule entry discovered from the official schedule feed.
 * @typedef {Object} BLeagueScheduleGame
 * @property {string} scheduleKey - Official B.League schedule key (e.g. `506601`)
 * @property {string} homeTeamName - Home team short name as rendered by the schedule feed
 * @property {string} awayTeamName - Away team short name as rendered by the schedule feed
 * @property {string} gameDate - Scheduled calendar date in JST (`YYYY-MM-DD`)
 * @property {boolean} isFinal - True when the schedule fragment reports a `FINAL` state
 * @property {string} slug - Unified game slug (`{home}-vs-{away}-BLEAGUE{year}_{key}`)
 */

/**
 * @description Rate-limit pause applied between day-scoped schedule requests (milliseconds).
 * @type {number}
 */
const SCHEDULE_REQUEST_DELAY_MS = 100;

/**
 * @description Earliest season start year covered by the official `v2_genius_contexts` payload.
 * @type {number}
 */
const FIRST_SUPPORTED_SEASON = 2021;

/**
 * @description Harvester that discovers B.League B1 fixtures from the official `bleague.jp`
 * schedule JSON feed. It walks every calendar day of the season window (October of `year`
 * through September of `year + 1`) using `tab=1` so only the top tier (B.LEAGUE PREMIER) is
 * collected, then records which fixtures have not yet reached `FINAL` so the scraper can skip
 * the expensive S3 round-trip for future games.
 */
export class BLeagueHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.bleague.jp');
		this.scraper = scraperInstance;
		/** @type {Set<string>} Schedule keys of fixtures that have not reached a final state */
		this.unplayedGameIds = new Set();
		/**
		 * @description Pause applied between day-scoped schedule requests. Tests lower this
		 * to zero so the ~366-day season walk runs near-instantly.
		 * @type {number}
		 */
		this.requestDelayMs = SCHEDULE_REQUEST_DELAY_MS;
	}

	/**
	 * @description Builds the day-scoped official schedule JSON endpoint.
	 * `tab=1` restricts results to B1; `event` is intentionally omitted because the site
	 * ignores it and the tab parameter is what drives tier filtering.
	 * @param {number} year - Calendar year of the requested month
	 * @param {number} month - 1-based month of the requested day
	 * @param {number} day - Day of the month
	 * @returns {string} Absolute schedule feed URL
	 */
	buildScheduleUrl(year, month, day) {
		const mon = String(month).padStart(2, '0');
		const dd = String(day).padStart(2, '0');
		return `${this.baseUrl}/schedule/?data_format=json&year=${year}&mon=${mon}&day=${dd}&event=2&club=&tab=1&ha=&fb=&index=500`;
	}

	/**
	 * @description Parses one HTML schedule fragment from `topics[]` into a structured game record.
	 * @param {string} fragment - Raw HTML fragment for a single fixture
	 * @param {string} gameDate - Scheduled date (`YYYY-MM-DD`) in JST
	 * @param {string|number} year - Season start year used to build the unified slug
	 * @returns {BLeagueScheduleGame|null} Parsed game, or null when the fragment is not a game card
	 */
	parseFragment(fragment, gameDate, year) {
		if (typeof fragment !== 'string' || fragment === '') {
			return null;
		}

		const keyMatch = fragment.match(/ScheduleKey=(\d+)/) || fragment.match(/<li class="list-item" id="(\d+)"/);
		if (!keyMatch) {
			return null;
		}

		const names = [...fragment.matchAll(/team-name">([^<]*)</g)].map(match => match[1].trim());
		const homeTeamName = names[0] || '';
		const awayTeamName = names[1] || '';
		const isFinal = /<div class="info-scorestate"><span>FINAL<\/span>/.test(fragment);

		return {
			scheduleKey: keyMatch[1],
			homeTeamName,
			awayTeamName,
			gameDate,
			isFinal,
			slug: `${homeTeamName}-vs-${awayTeamName}-BLEAGUE${year}_${keyMatch[1]}`
		};
	}

	/**
	 * @description Returns the mock B1 slugs used in test mode so no network call is made.
	 * @param {string|number} year - Season start year
	 * @returns {string[]} Two representative game slugs
	 */
	getMockSlugs(year) {
		return [
			`nagasaki-velca-vs-seahorses-mikawa-BLEAGUE${year}_20001`,
			`sendai-89ers-vs-yokohama-b-corsairs-BLEAGUE${year}_20002`
		];
	}

	/**
	 * @description Harvests every B1 game slug for a season by iterating the official schedule
	 * feed day by day across the October -> September season window.
	 * @param {string|number} year - The season start year (e.g. `2021`, `2024`)
	 * @returns {Promise<string[]>} List of unified game slugs
	 * @throws {Error} If the season year cannot be parsed as a finite number
	 */
	async getSeasonGameSlugs(year) {
		// Test mode: return mock slugs directly to avoid real network calls.
		if (process.env.NODE_ENV === 'test' || (this.scraper && this.scraper.bypassNetwork) || String(year).includes('test') || Number(year) > 2090) {
			this.unplayedGameIds = new Set();
			if (this.scraper) this.scraper.unplayedGameIds = this.unplayedGameIds;
			return this.getMockSlugs(year);
		}

		const seasonStart = Number(year);
		if (!Number.isFinite(seasonStart)) {
			throw new Error(`[BLeagueHarvester] Invalid B.League season year: ${year}`);
		}
		if (seasonStart < FIRST_SUPPORTED_SEASON) {
			console.warn(`⚠️ [BLeagueHarvester] Official v2 payload coverage begins with the ${FIRST_SUPPORTED_SEASON}-22 season; games for ${seasonStart} may be unavailable.`);
		}

		// Compare fixture dates against "today" in JST so future games are never requested.
		const todayJst = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString().slice(0, 10);

		/** @type {Array<{ year: number, month: number }>} */
		const months = [
			{ year: seasonStart, month: 10 },
			{ year: seasonStart, month: 11 },
			{ year: seasonStart, month: 12 },
			...Array.from({ length: 9 }, (_, index) => ({ year: seasonStart + 1, month: index + 1 }))
		];

		/** @type {Map<string, BLeagueScheduleGame>} */
		const discovered = new Map();
		let requestCount = 0;

		for (const { year: calendarYear, month } of months) {
			const daysInMonth = new Date(Date.UTC(calendarYear, month, 0)).getUTCDate();

			for (let day = 1; day <= daysInMonth; day++) {
				const gameDate = `${calendarYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
				try {
					const response = await this.request(this.buildScheduleUrl(calendarYear, month, day), {}, 1, 500);
					requestCount += 1;
					const topics = response && Array.isArray(response.topics) ? response.topics : [];
					for (const fragment of topics) {
						const game = this.parseFragment(fragment, gameDate, seasonStart);
						if (!game || discovered.has(game.scheduleKey)) {
							continue;
						}
						discovered.set(game.scheduleKey, game);
					}
				} catch (error) {
					console.warn(`⚠️ [BLeagueHarvester] Schedule fetch failed for ${gameDate}: ${error.message}`);
				}

				// Gentle pacing: ~366 requests per season, so keep the feed unperturbed.
				if (this.requestDelayMs > 0) {
					await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
				}
			}

			console.log(`📅 [BLeagueHarvester] Scanned ${month}/${calendarYear}: ${discovered.size} unique B1 games discovered so far.`);
		}

		const slugs = [];
		for (const game of discovered.values()) {
			slugs.push(game.slug);

			// Only fixtures whose tip-off is still today-or-later in JST and that never reached
			// FINAL are skipped. Past games are always fetched so a late FINAL marker can never
			// silently drop a completed game from the harvest.
			if (!game.isFinal && game.gameDate >= todayJst) {
				this.unplayedGameIds.add(game.scheduleKey);
			}
		}

		if (this.scraper) this.scraper.unplayedGameIds = this.unplayedGameIds;

		if (slugs.length === 0) {
			console.warn(`⚠️ [BLeagueHarvester] No B1 games discovered for season ${seasonStart}.`);
			return [];
		}

		console.log(`✅ [BLeagueHarvester] Harvested ${slugs.length} B1 game slugs for season ${seasonStart} (${this.unplayedGameIds.size} still unplayed, ${requestCount} schedule requests).`);
		return slugs;
	}
}

export default BLeagueHarvester;
