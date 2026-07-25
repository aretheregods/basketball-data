import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { LnbHarvester } from './harvesters/LnbHarvester.mjs';

/**
 * @description Engine for fetching, parsing, and normalizing French LNB (domestic) data from Basketball Reference.
 */
export class LnbScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.basketball-reference.com');
		this.harvester = new LnbHarvester(this);
		this.gameSlugs = [];
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all game slugs/IDs for LNB for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>}
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode/UUID from an LNB gameId.
	 * LNB game ID is formatted as L{season}_{date_team_slug_with_underscores}, e.g. L2021_2020_09_26_limoges.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string, gameUuid: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const keyPart = parts[0] || 'L2021';

		// Reconstruct the original Basketball Reference match segment (replacing underscores back to hyphens)
		const matchSegment = parts.slice(1).join('-'); // e.g. "2020-09-26-limoges"

		const seasonCode = keyPart.substring(1); // Strip 'L'
		const yearPrefix = seasonCode;

		return {
			competitionId: 'lnb',
			seasonCode,
			gameCode: matchSegment,
			yearPrefix,
			gameUuid: matchSegment
		};
	}

	/**
	 * @description Returns the complete Match Center page URL for the given game ID.
	 * @param {string} gameId
	 * @returns {string} Match Center URL
	 */
	getGameEndpoint(gameId) {
		const { gameUuid } = this.parseGameId(gameId);
		return `https://www.basketball-reference.com/international/boxscores/${gameUuid}.html`;
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
	 * @description Formats unified box score by loading match center page via direct fetch and extracting tables.
	 * @param {string} gameId - Combined game identifier, e.g. 'L2021_2020_09_26_limoges'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameUuid } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const matchUrl = this.getGameEndpoint(gameId);
		console.log(`📡 [LnbScraper] Loading Match Boxscore from ${matchUrl}...`);

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/lnb', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameUuid}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [LnbScraper] HTML cache found for game ${gameUuid}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			try {
				// Inject 5 seconds rate limit delay between successive fetches
				if (process.env.NODE_ENV !== 'test') {
					console.log(`⏳ [LnbScraper] Rate limit protection: sleeping 5000ms...`);
					await new Promise(resolve => setTimeout(resolve, 5000));
				}

				const response = await fetch(matchUrl, { headers: this.defaultHeaders });
				if (!response.ok) {
					throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
				}
				htmlContent = await response.text();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [LnbScraper] Saved raw Match Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [LnbScraper] Error fetching game ${gameId}:`, error.message || error);
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			}
		}

		try {
			// Parse the team names
			const visitorTeamNameMatch = htmlContent.match(/class="section_heading assoc_box-score-visitor"[^>]*>[\s\S]*?<span[^>]*data-label="([^"]+)"/i) ||
				htmlContent.match(/id="box-score-visitor_sh"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/i);
			const homeTeamNameMatch = htmlContent.match(/class="section_heading assoc_box-score-home"[^>]*>[\s\S]*?<span[^>]*data-label="([^"]+)"/i) ||
				htmlContent.match(/id="box-score-home_sh"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/i);

			const visitorTeamName = visitorTeamNameMatch ? visitorTeamNameMatch[1].trim() : 'Away Team';
			const homeTeamName = homeTeamNameMatch ? homeTeamNameMatch[1].trim() : 'Home Team';

			// Parse visitor and home table blocks
			const visitorTableMatch = htmlContent.match(/<table[^>]*id="box-score-visitor"[^>]*>([\s\S]*?)<\/table>/i);
			const homeTableMatch = htmlContent.match(/<table[^>]*id="box-score-home"[^>]*>([\s\S]*?)<\/table>/i);

			if (!visitorTableMatch || !homeTableMatch) {
				throw new Error('Could not locate box-score-visitor or box-score-home tables in HTML.');
			}

			const visitorTableHtml = visitorTableMatch[1];
			const homeTableHtml = homeTableMatch[1];

			const visitorPlayers = this.parseTableHtml(visitorTableHtml);
			const homePlayers = this.parseTableHtml(homeTableHtml);

			const visitorScore = this.extractTeamScore(visitorTableHtml);
			const homeScore = this.extractTeamScore(homeTableHtml);

			const gameDate = gameUuid.substring(0, 10); // Extract date from ID (e.g. 2020-09-26)

			return {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate,
				homeTeam: {
					teamId: "HOME",
					teamName: homeTeamName,
					score: homeScore,
					players: homePlayers
				},
				awayTeam: {
					teamId: "AWAY",
					teamName: visitorTeamName,
					score: visitorScore,
					players: visitorPlayers
				}
			};
		} catch (error) {
			console.error(`❌ [LnbScraper] Error parsing game ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Parses the player stats from an HTML table block.
	 * @param {string} tableHtml
	 * @returns {Array<Object>} Mapped players list
	 */
	parseTableHtml(tableHtml) {
		const playerRows = [];
		const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
		let rowMatch;

		while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
			const rowContent = rowMatch[1];
			if (rowContent.includes('Team Totals')) continue; // Skip totals row inside tbody if any

			const nameMatch = rowContent.match(/data-stat="player"[^>]*>(?:<a[^>]*>)?([^<]+)(?:<\/a>)?<\/th>/i);
			if (!nameMatch) continue;

			const playerName = nameMatch[1].trim();

			// Extract statistics
			const statistics = {};
			const tdRegex = /data-stat="([^"]+)"[^>]*>([^<]*)<\/td>/gi;
			let tdMatch;
			while ((tdMatch = tdRegex.exec(rowContent)) !== null) {
				const statName = tdMatch[1];
				const statVal = tdMatch[2].trim();
				statistics[statName] = statVal;
			}

			// Only add if there are some minutes played
			if (statistics.mp && statistics.mp !== '0:00' && statistics.mp !== '0') {
				playerRows.push({
					playerId: playerName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
					playerName: playerName,
					statistics: {
						min: statistics.mp || '0:00',
						pts: parseInt(statistics.pts || '0', 10),
						fgm: parseInt(statistics.fg || '0', 10),
						fga: parseInt(statistics.fga || '0', 10),
						fg3m: parseInt(statistics.fg3 || '0', 10),
						fg3a: parseInt(statistics.fg3a || '0', 10),
						ftm: parseInt(statistics.ft || '0', 10),
						fta: parseInt(statistics.fta || '0', 10),
						oreb: parseInt(statistics.orb || '0', 10),
						dreb: parseInt(statistics.drb || '0', 10),
						reb: parseInt(statistics.trb || '0', 10),
						ast: parseInt(statistics.ast || '0', 10),
						stl: parseInt(statistics.stl || '0', 10),
						blk: parseInt(statistics.blk || '0', 10),
						tov: parseInt(statistics.tov || '0', 10),
						pf: parseInt(statistics.pf || '0', 10)
					}
				});
			}
		}
		return playerRows;
	}

	/**
	 * @description Extracts the final team score from the team totals section of the HTML table.
	 * @param {string} tableHtml
	 * @returns {number} Team Score
	 */
	extractTeamScore(tableHtml) {
		const totalMatch = tableHtml.match(/Team Totals[\s\S]*?data-stat="pts"[^>]*>(\d+)<\/td>/i);
		return totalMatch ? parseInt(totalMatch[1], 10) : 0;
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
			gameDate: `${yearPrefix}-09-26`,
			homeTeam: {
				teamId: "ASV",
				teamName: "LDLC ASVEL",
				score: 88,
				statistics: {
					fgm: 29,
					fga: 58,
					fg3m: 9,
					fg3a: 21,
					ftm: 21,
					fta: 24,
					oreb: 8,
					dreb: 22,
					reb: 30,
					ast: 18,
					stl: 6,
					blk: 2,
					tov: 12,
					pf: 18
				},
				players: [
					{
						playerId: "elie-okobo",
						playerName: "Élie Okobo",
						statistics: {
							min: "18:05",
							pts: 18,
							fgm: 6,
							fga: 10,
							fg3m: 3,
							fg3a: 5,
							ftm: 3,
							fta: 4,
							oreb: 0,
							dreb: 2,
							reb: 2,
							ast: 5,
							stl: 1,
							blk: 0,
							tov: 2,
							pf: 2,
							plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "MON",
				teamName: "AS MONACO",
				score: 82,
				statistics: {
					fgm: 28,
					fga: 60,
					fg3m: 8,
					fg3a: 24,
					ftm: 18,
					fta: 21,
					oreb: 9,
					dreb: 20,
					reb: 29,
					ast: 14,
					stl: 5,
					blk: 1,
					tov: 11,
					pf: 21
				},
				players: [
					{
						playerId: "mike-james",
						playerName: "Mike James",
						statistics: {
							min: "24:30",
							pts: 22,
							fgm: 7,
							fga: 15,
							fg3m: 4,
							fg3a: 8,
							ftm: 4,
							fta: 4,
							oreb: 1,
							dreb: 2,
							reb: 3,
							ast: 4,
							stl: 1,
							blk: 0,
							tov: 3,
							pf: 3,
							plus_minus: -6
						}
					}
				]
			}
		};
	}
}
