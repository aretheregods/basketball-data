import { HTTPClient } from '#utils';

/**
 * @description Harvester for Lega Basket Serie A (LBA - Italy) schedules.
 * Discovers and collects match IDs from the legabasket.it calendar.
 */
export class LbaHarvester extends HTTPClient {
	/**
	 * @constructor
	 * @param {Object} [scraperInstance] - The parent scraper instance
	 */
	constructor(scraperInstance) {
		super('https://www.legabasket.it');
		this.scraper = scraperInstance;
	}

	/**
	 * @description Fetches all game slugs/IDs for LBA for a given season.
	 * @param {string|number} year - The season start year (e.g. 2024)
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		// If in test mode, return mock slugs to avoid real network calls
		if (process.env.NODE_ENV === 'test') {
			return [
				`unahotels-reggio-emilia-vs-dolomiti-energia-trentino-I${year}_24662`,
				`ea7-emporio-armani-milano-vs-virtus-segafredo-bologna-I${year}_24663`
			];
		}

		const calendarUrl = `/calendario/1/serie-a?stagione=${year}`;
		console.log(`📡 [LbaHarvester] Fetching calendar from ${this.baseUrl}${calendarUrl}...`);

		try {
			const htmlText = await this.requestText(calendarUrl);
			if (!htmlText) {
				console.warn(`⚠️ [LbaHarvester] Empty response received for LBA calendar.`);
				return [];
			}

			// Extract __NEXT_DATA__ script tag
			const start = htmlText.indexOf('__NEXT_DATA__');
			if (start === -1) {
				console.warn(`⚠️ [LbaHarvester] __NEXT_DATA__ tag not found in calendar HTML.`);
				return [];
			}

			const scriptStart = htmlText.lastIndexOf('<script', start);
			const scriptEnd = htmlText.indexOf('</script>', start);
			const scriptContent = htmlText.substring(scriptStart, scriptEnd);
			const jsonStart = scriptContent.indexOf('{');
			const jsonContent = scriptContent.substring(jsonStart);
			const data = JSON.parse(jsonContent);

			const competitions = data.props?.pageProps?.allCompetitionsBySeriesId?.competitions || [];
			// Filter competitions for the target year
			const targetComps = competitions.filter(c => c.year === parseInt(year, 10) && c.championship_series_id === 1);

			if (targetComps.length === 0) {
				console.warn(`⚠️ [LbaHarvester] No LBA competitions found for season ${year}.`);
				return [];
			}

			console.log(`🔍 [LbaHarvester] Found ${targetComps.length} competitions for season ${year}.`);
			const gameSlugs = [];

			const slugify = (text) => {
				return text
					.toLowerCase()
					.replace(/[^a-z0-9\s-]/g, '')
					.trim()
					.replace(/[\s-]+/g, '-');
			};

			for (const comp of targetComps) {
				console.log(`📡 [LbaHarvester] Fetching schedule details for competition: "${comp.name}" (ID: ${comp.id})...`);
				// Fetch the filters for the competition
				const filterUrl = `https://www.legabasket.it/api/championships/get-championships-calendar-by-id?id=${comp.id}`;
				const filterResponse = await fetch(filterUrl, { headers: this.defaultHeaders });
				if (!filterResponse.ok) {
					console.warn(`⚠️ [LbaHarvester] Failed to fetch filters for competition ${comp.id}`);
					continue;
				}
				const compData = await filterResponse.json();

				if (compData.filters?.phases && compData.filters.phases.length > 0) {
					// Playoff/tournament with phases
					for (const phase of compData.filters.phases) {
						console.log(`📡 [LbaHarvester] Fetching playoff phase "${phase.phase_name}" (ID: ${phase.id})...`);
						const phaseUrl = `https://www.legabasket.it/api/championships/get-championships-calendar-by-id?id=${comp.id}&ph_id=${phase.id}`;
						try {
							const phaseResponse = await fetch(phaseUrl, { headers: this.defaultHeaders });
							if (phaseResponse.ok) {
								const phaseData = await phaseResponse.json();
								const matches = phaseData.matches || [];
								for (const match of matches) {
									if (match && match.id && match.h_team_name && match.v_team_name) {
										const awaySlug = slugify(match.v_team_name);
										const homeSlug = slugify(match.h_team_name);
										gameSlugs.push(`${awaySlug}-vs-${homeSlug}-I${year}_${match.id}`);
									}
								}
							}
						} catch (err) {
							console.error(`❌ [LbaHarvester] Error fetching phase ${phase.id}:`, err.message);
						}
					}
				} else if (compData.filters?.days && compData.filters.days.length > 0) {
					// Regular season with days/matchdays
					for (const day of compData.filters.days) {
						console.log(`📡 [LbaHarvester] Fetching match day "${day.name}" (Code: ${day.code})...`);
						// Inject a tiny randomized sleep delay between successive matchday requests to respect rate limits
						if (process.env.NODE_ENV !== 'test') {
							const delayTime = 500 + Math.random() * 500;
							await new Promise(resolve => setTimeout(resolve, delayTime));
						}

						const dayUrl = `https://www.legabasket.it/api/championships/get-championships-calendar-by-id?id=${comp.id}&d=${day.code}`;
						try {
							const dayResponse = await fetch(dayUrl, { headers: this.defaultHeaders });
							if (dayResponse.ok) {
								const dayData = await dayResponse.json();
								const matches = dayData.matches || [];
								for (const match of matches) {
									if (match && match.id && match.h_team_name && match.v_team_name) {
										const awaySlug = slugify(match.v_team_name);
										const homeSlug = slugify(match.h_team_name);
										gameSlugs.push(`${awaySlug}-vs-${homeSlug}-I${year}_${match.id}`);
									}
								}
							}
						} catch (err) {
							console.error(`❌ [LbaHarvester] Error fetching day ${day.code}:`, err.message);
						}
					}
				}
			}

			const uniqueSlugs = [...new Set(gameSlugs)];
			console.log(`✅ [LbaHarvester] Successfully harvested ${uniqueSlugs.length} unique games for season ${year}.`);
			return uniqueSlugs;
		} catch (error) {
			console.error(`❌ [LbaHarvester] Failed to harvest LBA calendar:`, error.message || error);
			return [];
		}
	}

	/**
	 * @description Helper to request HTML text.
	 * @param {string} endpoint
	 * @returns {Promise<string>}
	 */
	async requestText(endpoint) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
		try {
			const response = await fetch(url, { headers: this.defaultHeaders });
			if (!response.ok) {
				throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
			}
			return await response.text();
		} catch (error) {
			console.error(`❌ [LbaHarvester] Fetch failed for ${url}:`, error.message || error);
			return '';
		}
	}
}
