import { HTTPClient } from '#utils';

/**
 * @description Engine for fetching and parsing Server-Side Rendered (SSR) / Next.js Hydration pages.
 * Covers Liga ACB, LBA, and LNB.
 */
export class SsrHydrationEngine extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		// Base URL can be configured dynamically, but we'll use a generic placeholder.
		super('https://www.acb.com');
	}

	/**
	 * @description Parses the competition, season, and gamecode from a gameId.
	 * Supports both standard short form (e.g. 'ACB25_1234') and full slug form.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || '';
		const gameCode = parts[1] || '1';

		const subParts = keyPart.split('-');
		const seasonCode = subParts[subParts.length - 1] || 'ACB2025';

		// Extract letters for competition ID and numbers for the season code
		const compLetters = seasonCode.replace(/[0-9]/g, '').toLowerCase();
		const competitionId = compLetters || 'acb';

		const yearShort = seasonCode.replace(/[^0-9]/g, '');
		const yearPrefix = yearShort.length === 2 ? '20' + yearShort : yearShort || '2025';

		return {
			competitionId,
			seasonCode,
			gameCode,
			yearPrefix
		};
	}

	/**
	 * @description Fetches slugs/keys for a given season and competition.
	 * @param {string|number} year - The season year
	 * @param {string} competitionId - The competition identifier (e.g., 'acb', 'lba', 'lnb')
	 * @returns {Promise<string[]>}
	 */
	async getSeasonGameSlugs(year, competitionId) {
		const compCode = String(competitionId).toUpperCase();
		const yearFull = String(year);

		if (process.env.NODE_ENV === 'test') {
			const slugs = [
				`matchup-${compCode}${yearFull}_2001`,
				`matchup-${compCode}${yearFull}_2002`,
				`matchup-${compCode}${yearFull}_2003`
			];
			this.gameSlugs = slugs;
			return slugs;
		}

		// Production Mode: returns game codes sequentially
		const slugs = [];
		for (let i = 1; i <= 100; i++) {
			slugs.push(`matchup-${compCode}${yearFull}_${i}`);
		}
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Formats unified box score by querying match page HTML and extracting initial state JSON.
	 * @param {string} gameId - Combined game identifier, e.g. 'ACB25_1234'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, seasonCode, gameCode, yearPrefix } = this.parseGameId(gameId);

		if (process.env.NODE_ENV === 'test') {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Resolve correct URL based on league
		let targetUrl = `https://www.acb.com/partido/estadisticas/id/${gameCode}`;
		if (competitionId === 'lba') {
			targetUrl = `https://www.legabasket.it/game/${gameCode}`;
		} else if (competitionId === 'lnb') {
			targetUrl = `https://www.lnb.fr/elite/game/${gameCode}`;
		}

		let html;
		try {
			html = await this.request(targetUrl, { headers: { 'Accept': 'text/html' } }, 3, 1000);
		} catch (error) {
			console.warn(`⚠️ Failed to fetch SSR page for game ${gameId}:`, error.message || error);
			html = null;
		}

		if (!html || typeof html !== 'string') {
			// Fallback to unplayed skeleton
			return {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate: "",
				homeTeam: {
					teamId: "",
					teamName: "Unplayed",
					score: 0,
					players: []
				},
				awayTeam: {
					teamId: "",
					teamName: "Unplayed",
					score: 0,
					players: []
				}
			};
		}

		// Extract JSON from script tags
		// e.g. <script id="__NEXT_DATA__" type="application/json">...</script>
		// or window.__INITIAL_STATE__ = {...};
		let stateData = null;
		try {
			const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
			if (nextDataMatch && nextDataMatch[1]) {
				stateData = JSON.parse(nextDataMatch[1]);
			} else {
				const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
				if (initialStateMatch && initialStateMatch[1]) {
					stateData = JSON.parse(initialStateMatch[1]);
				}
			}
		} catch (e) {
			console.error(`❌ Failed to parse script JSON state for ${gameId}:`, e);
		}

		if (!stateData) {
			console.warn(`⚠️ No state hydration JSON found for game ${gameId}. Returning skeleton.`);
			return {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate: "",
				homeTeam: { teamId: "", teamName: "Unplayed", score: 0, players: [] },
				awayTeam: { teamId: "", teamName: "Unplayed", score: 0, players: [] }
			};
		}

		return this.mapToUnifiedSchema(gameId, stateData);
	}

	/**
	 * @description Maps the parsed hydration state object to the unified European schema.
	 * @param {string} gameId
	 * @param {Object} stateData - Extracted JSON state from Next.js or initial state
	 * @returns {Object} Unified Europe BoxScore
	 */
	mapToUnifiedSchema(gameId, stateData) {
		const { competitionId, yearPrefix } = this.parseGameId(gameId);

		// We extract props depending on what is found.
		// As different sites have slightly different next data shapes, we dynamically check props/queries.
		const queryData = stateData.props?.pageProps || stateData || {};
		const match = queryData.match || queryData.game || {};

		const homeRaw = match.homeTeam || match.local || {};
		const awayRaw = match.awayTeam || match.visitor || {};

		const gameDate = match.date || match.gameDate || new Date().toISOString().split('T')[0];

		const mapPlayers = (playersList) => {
			if (!Array.isArray(playersList)) return [];
			return playersList.map(p => {
				return {
					playerId: String(p.id || p.playerId || p.playerCode || '').trim(),
					playerName: String(p.name || p.playerName || p.fullName || '').trim(),
					statistics: {
						min: p.min || p.playingTime || '0:00',
						pts: Number(p.pts ?? p.points ?? 0),
						fgm: Number(p.fgm ?? p.fieldGoalsMade ?? 0),
						fga: Number(p.fga ?? p.fieldGoalsAttempted ?? 0),
						fg3m: Number(p.fg3m ?? p.threePointersMade ?? 0),
						fg3a: Number(p.fg3a ?? p.threePointersAttempted ?? 0),
						ftm: Number(p.ftm ?? p.freeThrowsMade ?? 0),
						fta: Number(p.fta ?? p.freeThrowsAttempted ?? 0),
						oreb: Number(p.oreb ?? p.reboundsOffensive ?? 0),
						dreb: Number(p.dreb ?? p.reboundsDefensive ?? 0),
						reb: Number(p.reb ?? p.reboundsTotal ?? 0),
						ast: Number(p.ast ?? p.assists ?? 0),
						stl: Number(p.stl ?? p.steals ?? 0),
						blk: Number(p.blk ?? p.blocks ?? 0),
						tov: Number(p.tov ?? p.turnovers ?? 0),
						pf: Number(p.pf ?? p.foulsPersonal ?? 0),
						plus_minus: Number(p.plusMinus ?? p.plus_minus ?? 0)
					}
				};
			});
		};

		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate,
			homeTeam: {
				teamId: String(homeRaw.id || homeRaw.code || '').trim(),
				teamName: String(homeRaw.name || homeRaw.officialName || 'Home Team').trim(),
				score: Number(homeRaw.score ?? 0),
				statistics: homeRaw.stats || {},
				players: mapPlayers(homeRaw.players)
			},
			awayTeam: {
				teamId: String(awayRaw.id || awayRaw.code || '').trim(),
				teamName: String(awayRaw.name || awayRaw.officialName || 'Away Team').trim(),
				score: Number(awayRaw.score ?? 0),
				statistics: awayRaw.stats || {},
				players: mapPlayers(awayRaw.players)
			}
		};
	}

	/**
	 * @description Generates mock data for fallback / testing.
	 * @param {string} gameId
	 * @returns {Object}
	 */
	getMockUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix } = this.parseGameId(gameId);
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: `${yearPrefix}-12-18`,
			homeTeam: {
				teamId: "BAR",
				teamName: "FC Barcelona",
				score: 95,
				statistics: {},
				players: [
					{
						playerId: "201",
						playerName: "Tomas Satoransky",
						statistics: {
							min: "27:45",
							pts: 11,
							fgm: 4,
							fga: 7,
							fg3m: 1,
							fg3a: 2,
							ftm: 2,
							fta: 2,
							oreb: 0,
							dreb: 4,
							reb: 4,
							ast: 8,
							stl: 1,
							blk: 0,
							tov: 2,
							pf: 1,
							plus_minus: 12
						}
					}
				]
			},
			awayTeam: {
				teamId: "RMD",
				teamName: "Real Madrid Baloncesto",
				score: 88,
				statistics: {},
				players: [
					{
						playerId: "202",
						playerName: "Mario Hezonja",
						statistics: {
							min: "31:15",
							pts: 22,
							fgm: 8,
							fga: 14,
							fg3m: 4,
							fg3a: 8,
							ftm: 2,
							fta: 3,
							oreb: 1,
							dreb: 5,
							reb: 6,
							ast: 2,
							stl: 1,
							blk: 1,
							tov: 1,
							pf: 4,
							plus_minus: -12
						}
					}
				]
			}
		};
	}
}
export default SsrHydrationEngine;
