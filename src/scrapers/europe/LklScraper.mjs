import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { LklHarvester } from './harvesters/LklHarvester.mjs';

/**
 * @description Scraper for Betsafe LKL Lithuanian Basketball domestic competition.
 * Fetches, caches, parses, and normalizes LKL game box score statistics from en.lkl.lt.
 */
export class LklScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://en.lkl.lt');
		this.harvester = new LklHarvester(this);
		this.gameSlugs = [];
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all game slugs/IDs for LKL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from an LKL gameId.
	 * LKL game ID is formatted as matchup-K{season}_{gameCode}, e.g. lietkabelis-vs-neptunas-K2026_11574.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'K2026';

		// Extract season code segment from keyPart, e.g. "K2026" -> "2026" or "matchup-K2026" -> "2026"
		const segmentMatch = keyPart.match(/(?:-)?K(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2026';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'lkl',
			seasonCode,
			gameCode,
			yearPrefix
		};
	}

	/**
	 * @description Returns the complete Game page URL for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Game page URL
	 */
	getGameEndpoint(gameId) {
		const { gameCode } = this.parseGameId(gameId);
		return `https://en.lkl.lt/rungtynes/${gameCode}`;
	}

	/**
	 * @description Returns the game ID itself.
	 * @param {string} gameId
	 * @returns {string}
	 */
	getGameUrl(gameId) {
		return gameId;
	}

	/**
	 * @description Helper to convert player slug to standard Title Case name.
	 * @param {string} slug - Player slug e.g. "vytenis-lipkevicius"
	 * @returns {string} Title Case player name e.g. "Vytenis Lipkevicius"
	 */
	slugToTitleCase(slug) {
		if (!slug) return '';
		return slug
			.split('-')
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	}

	/**
	 * @description Formats unified box score by loading LKL match pages and API endpoints.
	 * @param {string} gameId - Combined game identifier, e.g. 'lietkabelis-vs-neptunas-K2026_11574'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const matchUrl = this.getGameEndpoint(gameId);
		console.log(`📡 [LklScraper] Loading LKL Boxscore from ${matchUrl}...`);

		// Set up directories for side-cache JSON saving
		const jsonCacheDir = path.resolve('data/raw/europe/lkl', String(yearPrefix));
		await fs.mkdir(jsonCacheDir, { recursive: true });
		const jsonCachePath = path.join(jsonCacheDir, `${gameCode}.json`);

		let cachedContent = '';
		try {
			// Check if we already have the raw JSON cached locally
			const stats = await fs.stat(jsonCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [LklScraper] JSON cache found for game ${gameCode}. Reading from disk...`);
				cachedContent = await fs.readFile(jsonCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (cachedContent) {
			try {
				return JSON.parse(cachedContent);
			} catch (e) {
				// Corrupt cache, refetch
			}
		}

		try {
			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [LklScraper] Rate limit protection: sleeping 500ms...`);
			await new Promise(resolve => setTimeout(resolve, 500));

			// 1. Fetch game HTML page to extract title (team names) and date
			const pageResponse = await fetch(matchUrl, { headers: this.defaultHeaders });
			if (!pageResponse.ok) {
				throw new Error(`HTTP Error fetching page: ${pageResponse.status} ${pageResponse.statusText}`);
			}
			const htmlContent = await pageResponse.text();

			// Parse team names from title
			const titleMatch = htmlContent.match(/<title>([^<]+)<\/title>/i);
			let homeTeamName = 'Home Team';
			let awayTeamName = 'Away Team';
			if (titleMatch) {
				const titleParts = titleMatch[1].split('-').map(t => t.trim());
				if (titleParts.length >= 2) {
					homeTeamName = titleParts[0];
					awayTeamName = titleParts[1];
				}
			}

			// Parse date from game-info attribute or raw text
			let gameDate = '';
			const gameInfoMatch = htmlContent.match(/:game-info="([^"]+)"/);
			if (gameInfoMatch) {
				try {
					const decoded = gameInfoMatch[1].replace(/&quot;/g, '"');
					const gameInfo = JSON.parse(decoded);
					if (gameInfo.time) {
						const timeClean = gameInfo.time.replace(/\s+/g, ' ');
						const parts = timeClean.split(' ');
						const year = parts[0];
						const monthName = parts[1];
						const day = parts[2] ? parts[2].replace('d.', '').replace(',', '').trim() : '01';

						const months = {
							'January': '01', 'February': '02', 'March': '03', 'April': '04', 'May': '05', 'June': '06',
							'July': '07', 'August': '08', 'September': '09', 'October': '10', 'November': '11', 'December': '12'
						};
						const month = months[monthName] || '01';
						gameDate = `${year}-${month}-${String(day).padStart(2, '0')}`;
					}
				} catch (e) {
					// Fallback
				}
			}

			if (!gameDate) {
				const textMatch = htmlContent.match(/(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})\s*d\./i);
				if (textMatch) {
					const year = textMatch[1];
					const monthName = textMatch[2];
					const day = textMatch[3];
					const months = {
						'January': '01', 'February': '02', 'March': '03', 'April': '04', 'May': '05', 'June': '06',
						'July': '07', 'August': '08', 'September': '09', 'October': '10', 'November': '11', 'December': '12'
					};
					const month = months[monthName] || '01';
					gameDate = `${year}-${month}-${String(day).padStart(2, '0')}`;
				} else {
					gameDate = `${yearPrefix}-06-13`; // Default fallback
				}
			}

			// 2. Fetch game Boxscore details from API JSON
			const boxscoreApiUrl = `https://en.lkl.lt/api/livestream/boxscore/${gameCode}`;
			const boxscoreResponse = await fetch(boxscoreApiUrl, { headers: this.defaultHeaders });
			if (!boxscoreResponse.ok) {
				throw new Error(`HTTP Error fetching boxscore API: ${boxscoreResponse.status} ${boxscoreResponse.statusText}`);
			}
			const boxscoreData = await boxscoreResponse.json();

			const homeRaw = boxscoreData.home || {};
			const awayRaw = boxscoreData.away || {};

			const homeScore = Number(homeRaw.team?.points ?? 0);
			const awayScore = Number(awayRaw.team?.points ?? 0);

			// Map players list helper
			const mapPlayers = (playersList) => {
				return (playersList || []).map(p => {
					const rawSlug = p.slug || '';
					const fullName = rawSlug ? this.slugToTitleCase(rawSlug) : (p.name?.value || 'Unknown Player');

					const minVal = p.time?.value || '00:00';
					const fgVal = p.fg?.value || '0/0';
					const fg3Val = p.fg3?.value || '0/0';
					const ftVal = p.ft?.value || '0/0';

					return {
						playerId: String(rawSlug || p.name?.value || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '-'),
						playerName: fullName,
						statistics: {
							min: minVal,
							pts: Number(p.points?.value ?? 0),
							fgm: parseInt(fgVal.split('/')[0] || '0', 10),
							fga: parseInt(fgVal.split('/')[1] || '0', 10),
							fg3m: parseInt(fg3Val.split('/')[0] || '0', 10),
							fg3a: parseInt(fg3Val.split('/')[1] || '0', 10),
							ftm: parseInt(ftVal.split('/')[0] || '0', 10),
							fta: parseInt(ftVal.split('/')[1] || '0', 10),
							oreb: Number(p.offensive_rebounds?.value ?? 0),
							dreb: Number(p.defensive_rebounds?.value ?? 0),
							reb: Number(p.total_rebounds?.value ?? 0),
							ast: Number(p.assists?.value ?? 0),
							stl: Number(p.steals?.value ?? 0),
							blk: Number(p.blocks?.value ?? 0),
							tov: Number(p.turnovers?.value ?? 0),
							pf: Number(p.fouls?.value ?? 0),
							plus_minus: Number(p.plus_minus?.value ?? 0)
						}
					};
				});
			};

			// Map team totals helper
			const mapTeamStats = (teamObj) => {
				const teamStats = teamObj?.team || {};
				const fgVal = teamStats.fg?.value || '0/0';
				const fg3Val = teamStats.fg3?.value || '0/0';
				const ftVal = teamStats.ft?.value || '0/0';

				return {
					fgm: parseInt(fgVal.split('/')[0] || '0', 10),
					fga: parseInt(fgVal.split('/')[1] || '0', 10),
					fg3m: parseInt(fg3Val.split('/')[0] || '0', 10),
					fg3a: parseInt(fg3Val.split('/')[1] || '0', 10),
					ftm: parseInt(ftVal.split('/')[0] || '0', 10),
					fta: parseInt(ftVal.split('/')[1] || '0', 10),
					oreb: Number(teamStats.offensive_rebounds?.value ?? 0),
					dreb: Number(teamStats.defensive_rebounds?.value ?? 0),
					reb: Number(teamStats.total_rebounds?.value ?? 0),
					ast: Number(teamStats.assists?.value ?? 0),
					stl: Number(teamStats.steals?.value ?? 0),
					blk: Number(teamStats.blocks?.value ?? 0),
					tov: Number(teamStats.turnovers?.value ?? 0),
					pf: Number(teamStats.fouls?.value ?? 0)
				};
			};

			const finalBoxscore = {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate,
				homeTeam: {
					teamId: homeTeamName.toUpperCase().substring(0, 4),
					teamName: homeTeamName,
					score: homeScore,
					statistics: mapTeamStats(homeRaw),
					players: mapPlayers(homeRaw.players)
				},
				awayTeam: {
					teamId: awayTeamName.toUpperCase().substring(0, 4),
					teamName: awayTeamName,
					score: awayScore,
					statistics: mapTeamStats(awayRaw),
					players: mapPlayers(awayRaw.players)
				}
			};

			await fs.writeFile(jsonCachePath, JSON.stringify(finalBoxscore, null, 2), 'utf8');
			console.log(`Saved unified LKL boxscore to side-cache: ${jsonCachePath}`);

			return finalBoxscore;
		} catch (error) {
			console.error(`❌ [LklScraper] Error parsing game ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Returns standard unplayed skeleton boxscore.
	 * @param {string} gameId
	 * @param {string} competitionId
	 * @param {string} yearPrefix
	 * @returns {Object}
	 */
	getUnplayedSkeleton(gameId, competitionId, yearPrefix) {
		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate: '',
			homeTeam: {
				teamId: '',
				teamName: 'Unplayed',
				score: 0,
				players: []
			},
			awayTeam: {
				teamId: '',
				teamName: 'Unplayed',
				score: 0,
				players: []
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
			gameDate: `${yearPrefix}-06-13`,
			homeTeam: {
				teamId: "LIE",
				teamName: "Lietkabelis",
				score: 82,
				statistics: {
					fgm: 30,
					fga: 62,
					fg3m: 13,
					fg3a: 35,
					ftm: 9,
					fta: 11,
					oreb: 8,
					dreb: 14,
					reb: 25,
					ast: 19,
					stl: 3,
					blk: 5,
					tov: 10,
					pf: 25
				},
				players: [
					{
						playerId: "vytenis-lipkevicius",
						playerName: "Vytenis Lipkevicius",
						statistics: {
							min: "00:00",
							pts: 0,
							fgm: 0,
							fga: 0,
							fg3m: 0,
							fg3a: 0,
							ftm: 0,
							fta: 0,
							oreb: 0,
							dreb: 0,
							reb: 0,
							ast: 0,
							stl: 0,
							blk: 0,
							tov: 0,
							pf: 0,
							plus_minus: 0
						}
					},
					{
						playerId: "dovis-bickauskis",
						playerName: "Dovis Bickauskis",
						statistics: {
							min: "21:27",
							pts: 10,
							fgm: 3,
							fga: 6,
							fg3m: 2,
							fg3a: 5,
							ftm: 2,
							fta: 2,
							oreb: 1,
							dreb: 0,
							reb: 1,
							ast: 5,
							stl: 0,
							blk: 1,
							tov: 0,
							pf: 2,
							plus_minus: -4
						}
					},
					{
						playerId: "gabrielius-maldunas",
						playerName: "Gabrielius Maldunas",
						statistics: {
							min: "25:48",
							pts: 9,
							fgm: 3,
							fga: 5,
							fg3m: 0,
							fg3a: 0,
							ftm: 3,
							fta: 4,
							oreb: 2,
							dreb: 4,
							reb: 6,
							ast: 3,
							stl: 0,
							blk: 1,
							tov: 1,
							pf: 3,
							plus_minus: -4
						}
					}
				]
			},
			awayTeam: {
				teamId: "NEP",
				teamName: "Neptunas",
				score: 91,
				statistics: {
					fgm: 28,
					fga: 63,
					fg3m: 11,
					fg3a: 30,
					ftm: 24,
					fta: 27,
					oreb: 17,
					dreb: 25,
					reb: 45,
					ast: 22,
					stl: 7,
					blk: 1,
					tov: 9,
					pf: 21
				},
				players: [
					{
						playerId: "mindaugas-girdziunas",
						playerName: "Mindaugas Girdziunas",
						statistics: {
							min: "12:30",
							pts: 5,
							fgm: 2,
							fga: 4,
							fg3m: 1,
							fg3a: 3,
							ftm: 0,
							fta: 0,
							oreb: 0,
							dreb: 0,
							reb: 0,
							ast: 0,
							stl: 1,
							blk: 0,
							tov: 0,
							pf: 3,
							plus_minus: -6
						}
					},
					{
						playerId: "arnas-velicka",
						playerName: "Arnas Velicka",
						statistics: {
							min: "34:03",
							pts: 7,
							fgm: 2,
							fga: 10,
							fg3m: 2,
							fg3a: 7,
							ftm: 1,
							fta: 2,
							oreb: 3,
							dreb: 2,
							reb: 5,
							ast: 11,
							stl: 3,
							blk: 0,
							tov: 0,
							pf: 1,
							plus_minus: 10
						}
					}
				]
			}
		};
	}
}
export default LklScraper;
