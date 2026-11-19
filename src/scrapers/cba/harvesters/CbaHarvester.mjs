import { HTTPClient } from '#utils';

/**
 * @description A single CBA schedule entry discovered from the official day feed.
 * @typedef {Object} CbaScheduleGame
 * @property {string} scheduleId - Official CBA schedule ID (e.g. `100110420`)
 * @property {string} homeTeamId - Official home team ID
 * @property {string} visitingTeamId - Official visiting team ID
 * @property {string} homeTeamName - Chinese home team name (sponsor branding varies per season)
 * @property {string} visitingTeamName - Chinese visiting team name
 * @property {number|null} homeScore - Official home score (null before the game is final)
 * @property {number|null} visitingScore - Official visiting score (null before the game is final)
 * @property {string} gameDate - Scheduled calendar date in `YYYY-MM-DD`
 * @property {number} status - Game status (1 scheduled, 2 live, 4 final)
 * @property {number} matchTypeId - Match type (1 regular season, 2 playoffs)
 * @property {boolean} isFinal - True when the feed reports a final state (status 4)
 * @property {string} slug - Unified game slug (`{home}-vs-{away}-CBA{year}_{scheduleId}`)
 */

/**
 * @description Rate-limit pause applied between day-scoped schedule requests (milliseconds).
 * @type {number}
 */
const DAY_REQUEST_DELAY_MS = 100;

/**
 * @description Earliest season start year supported by the official CBA data-server API.
 * @type {number}
 */
const FIRST_SUPPORTED_SEASON = 2015;

/**
 * @description Match type IDs collected by this pipeline (regular season and playoffs only;
 * All-Star games, tournaments and other exhibition fixtures are excluded).
 * @type {Set<number>}
 */
const COLLECTED_MATCH_TYPES = new Set([1, 2]);

/**
 * @description Harvester that discovers CBA fixtures from the official `data-server.cbaleague.com`
 * schedule feeds. It month-pre-filters calendar days that host games, then walks only those days
 * through `/schedules/day`, keeping regular season (1) and playoff (2) games for the
 * October(`year`) -> September(`year + 1`) season window. Discovered game metadata is propagated
 * to the parent scraper as `gameIndex` so box score requests resolve team names/IDs/scores and
 * play status without any extra API round-trips.
 */
export class CbaHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - Parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://data-server.cbaleague.com/api', { 'isEncrypt': 'no' });
		this.scraper = scraperInstance;
		/** @type {Set<string>} Schedule IDs of fixtures that have not reached a final state */
		this.unplayedGameIds = new Set();
		/** @type {Map<string, CbaScheduleGame>} Schedule ID -> harvested game metadata */
		this.gameIndex = new Map();
		/**
		 * @description Pause applied between day-scoped schedule requests. Tests lower this
		 * to zero so the day walk runs near-instantly.
		 * @type {number}
		 */
		this.requestDelayMs = DAY_REQUEST_DELAY_MS;
	}

	/**
	 * @description Builds the month-scoped schedule endpoint used to pre-filter days that host games.
	 * @param {number} year - Calendar year of the requested month
	 * @param {number} month - 1-based month of the requested day
	 * @returns {string} Absolute month schedule endpoint path
	 */
	buildMonthUrl(year, month) {
		return `/schedules/month?year=${year}&month=${month}`;
	}

	/**
	 * @description Builds the day-scoped schedule endpoint listing every game of one calendar day.
	 * @param {string} day - Calendar day (`YYYY-MM-DD`)
	 * @returns {string} Absolute day schedule endpoint path
	 */
	buildDayUrl(day) {
		return `/schedules/day?day=${day}&auto=0`;
	}

	/**
	 * @description Parses one raw day-feed game record into a structured schedule entry.
	 * Non-regular-season/playoff fixtures (matchTypeId outside 1/2) are rejected here so All-Star
	 * and tournament games never enter the harvest.
	 * @param {any} raw - Raw game record from `/schedules/day`
	 * @param {string|number} seasonYear - Season start year used to build the unified slug
	 * @returns {CbaScheduleGame|null} Parsed game, or null when the record is not an in-scope game
	 */
	parseScheduleGame(raw, seasonYear) {
		if (!raw || typeof raw !== 'object') {
			return null;
		}
		if (!COLLECTED_MATCH_TYPES.has(Number(raw.matchTypeId))) {
			return null;
		}
		const scheduleId = String(raw.scheduleId ?? '').trim();
		if (!scheduleId) {
			return null;
		}
		const homeTeamName = String(raw.homeTeamName ?? '').trim();
		const visitingTeamName = String(raw.visitingTeamName ?? '').trim();
		const status = Number(raw.status);
		const gameDate = String(raw.scheduleTime ?? '').slice(0, 10);

		return {
			scheduleId,
			homeTeamId: String(raw.homeTeamId ?? ''),
			visitingTeamId: String(raw.visitingTeamId ?? ''),
			homeTeamName,
			visitingTeamName,
			homeScore: raw.homeTeamScore ?? null,
			visitingScore: raw.visitingTeamScore ?? null,
			gameDate,
			status: Number.isFinite(status) ? status : null,
			matchTypeId: Number(raw.matchTypeId),
			isFinal: status === 4,
			slug: `${homeTeamName}-vs-${visitingTeamName}-CBA${seasonYear}_${scheduleId}`
		};
	}

	/**
	 * @description Returns the mock CBA slugs used in test mode so no network call is made.
	 * Team names are real Chinese CBA names so `config/cba_team_mappings.json` resolves them.
	 * @param {string|number} year - Season start year
	 * @returns {string[]} Two representative game slugs
	 */
	getMockSlugs(year) {
		return [
			`广东东阳光-vs-辽宁本钢-CBA${year}_20001`,
			`浙江稠州金租-vs-新疆伊力特-CBA${year}_20002`
		];
	}

	/**
	 * @description Harvests every regular season and playoff CBA game for a season by month
	 * pre-filtering game days across the October -> September season window, then walking only
	 * those days through the day feed.
	 * @param {string|number} year - The season start year (e.g. `2024` = the 2024-25 season)
	 * @returns {Promise<string[]>} List of unified game slugs
	 * @throws {Error} If the season year cannot be parsed as a finite number
	 */
	async getSeasonGameSlugs(year) {
		// Test mode: return mock slugs directly to avoid real network calls.
		if (process.env.NODE_ENV === 'test' || (this.scraper && this.scraper.bypassNetwork) || String(year).includes('test') || Number(year) > 2090) {
			this.unplayedGameIds = new Set();
			this.gameIndex = new Map();
			if (this.scraper) {
				this.scraper.unplayedGameIds = this.unplayedGameIds;
				this.scraper.gameIndex = this.gameIndex;
			}
			return this.getMockSlugs(year);
		}

		const seasonStart = Number(year);
		if (!Number.isFinite(seasonStart)) {
			throw new Error(`[CbaHarvester] Invalid CBA season year: ${year}`);
		}
		if (seasonStart < FIRST_SUPPORTED_SEASON) {
			console.warn(`⚠️ [CbaHarvester] Official CBA data-server coverage begins with the ${FIRST_SUPPORTED_SEASON}-16 season; games for ${seasonStart} may be unavailable.`);
		}

		/** @type {Array<{ year: number, month: number }>} */
		const months = [
			{ year: seasonStart, month: 10 },
			{ year: seasonStart, month: 11 },
			{ year: seasonStart, month: 12 },
			...Array.from({ length: 9 }, (_, index) => ({ year: seasonStart + 1, month: index + 1 }))
		];

		/** @type {Map<string, CbaScheduleGame>} */
		const discovered = new Map();
		let requestCount = 0;

		for (const { year: calendarYear, month } of months) {
			// Month pre-filter: only days whose month response carries games are walked.
			/** @type {string[]} */
			let days = [];
			try {
				const monthRows = await this.request(this.buildMonthUrl(calendarYear, month), {}, 1, 500);
				requestCount += 1;
				days = (Array.isArray(monthRows) ? monthRows : [])
					.filter(row => row && row.scheduleNum)
					.map(row => String(row.scheduleTime ?? '').slice(0, 10))
					.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day));
			} catch (error) {
				console.warn(`⚠️ [CbaHarvester] Month schedule fetch failed for ${month}/${calendarYear}: ${error.message}`);
			}
			days = [...new Set(days)].sort();

			for (const day of days) {
				try {
					const dayGames = await this.request(this.buildDayUrl(day), {}, 1, 500);
					requestCount += 1;
					for (const raw of Array.isArray(dayGames) ? dayGames : []) {
						const game = this.parseScheduleGame(raw, seasonStart);
						if (!game || discovered.has(game.scheduleId)) {
							continue;
						}
						discovered.set(game.scheduleId, game);
					}
				} catch (error) {
					console.warn(`⚠️ [CbaHarvester] Day schedule fetch failed for ${day}: ${error.message}`);
				}

				// Gentle pacing keeps the official data-server unperturbed.
				if (this.requestDelayMs > 0) {
					await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
				}
			}

			console.log(`📅 [CbaHarvester] Scanned ${month}/${calendarYear}: ${discovered.size} unique CBA games discovered so far.`);
		}

		const slugs = [];
		for (const game of discovered.values()) {
			slugs.push(game.slug);

			// Any fixture that never reached the final state (scheduled or live at harvest
			// time) is skipped by the extract stage; a later re-run re-classifies it.
			if (!game.isFinal) {
				this.unplayedGameIds.add(game.scheduleId);
			}
		}

		this.gameIndex = discovered;
		if (this.scraper) {
			this.scraper.unplayedGameIds = this.unplayedGameIds;
			this.scraper.gameIndex = discovered;
		}

		if (slugs.length === 0) {
			console.warn(`⚠️ [CbaHarvester] No CBA games discovered for season ${seasonStart}.`);
			return [];
		}

		console.log(`✅ [CbaHarvester] Harvested ${slugs.length} CBA game slugs for season ${seasonStart} (${this.unplayedGameIds.size} still unplayed, ${requestCount} schedule requests).`);
		return slugs;
	}
}

export default CbaHarvester;
