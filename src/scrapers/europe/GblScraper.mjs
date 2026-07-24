import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { GblHarvester } from './harvesters/GblHarvester.mjs';

/**
 * @description Scraper for Greek Basketball Stoiximan GBL domestic competition.
 * Fetches, caches, parses, and normalizes GBL game box score pages.
 */
export class GblScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.esake.gr');
		this.harvester = new GblHarvester(this);
		this.gameSlugs = [];
	}

	/**
	 * @description Fetches all game slugs/IDs for GBL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a GBL gameId.
	 * GBL game ID is formatted as matchup-G{season}_{gameCode}, e.g. olympiacos-vs-panathinaikos-G2026_65708E5D.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'G2026';

		// Extract season code segment from keyPart, e.g. "G2026" -> "2026" or "matchup-G2026" -> "2026"
		const segmentMatch = keyPart.match(/(?:-)?G(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2026';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'gbl',
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
		return `https://www.esake.gr/en/action/EsakegameView?idgame=${gameCode}&mode=3`;
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
	 * @description Formats unified box score by loading match center page via direct fetch and parsing tables.
	 * @param {string} gameId - Combined game identifier, e.g. 'olympiacos-vs-panathinaikos-G2026_65708E5D'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (process.env.NODE_ENV === 'test') {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const matchUrl = this.getGameEndpoint(gameId);
		console.log(`📡 [GblScraper] Loading GBL Boxscore from ${matchUrl}...`);

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/gbl', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [GblScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			try {
				// Inject 5 seconds rate limit delay between successive fetches
				if (process.env.NODE_ENV !== 'test') {
					console.log(`⏳ [GblScraper] Rate limit protection: sleeping 5000ms...`);
					await new Promise(resolve => setTimeout(resolve, 5000));
				}

				const response = await fetch(matchUrl, { headers: this.defaultHeaders });
				if (!response.ok) {
					throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
				}
				htmlContent = await response.text();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [GblScraper] Saved raw GBL Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [GblScraper] Error fetching game ${gameId}:`, error.message || error);
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			}
		}

		try {
			// Find all tables on the page
			const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
			let match;
			const tables = [];
			while ((match = tableRegex.exec(htmlContent)) !== null) {
				tables.push(match[1]);
			}

			// Helper to get raw cells from a table row HTML
			const getCells = (rowHtml) => {
				const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
				let m;
				const cells = [];
				while ((m = tdRegex.exec(rowHtml)) !== null) {
					cells.push(m[1].replace(/<[^>]+>/g, '').trim());
				}
				return cells;
			};

			// Filter tables containing actual player stats (by checking for row with TIM.PL or containing time-like values)
			const statsTables = [];
			for (const tHtml of tables) {
				const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
				let rMatch;
				const rows = [];
				while ((rMatch = rowRegex.exec(tHtml)) !== null) {
					rows.push(rMatch[1]);
				}

				// Check if there are some rows containing standard GBL stats pattern
				let isStatsTable = false;
				for (const rHtml of rows) {
					const cells = getCells(rHtml);
					if (cells.length >= 15 && cells.some(c => /^\d{2}:\d{2}(:\d{2})?$/.test(c))) {
						isStatsTable = true;
						break;
					}
				}

				if (isStatsTable) {
					statsTables.push(rows);
				}
			}

			if (statsTables.length < 2) {
				throw new Error(`Could not find both home and away player statistics tables in HTML.`);
			}

			// Restrict team name extraction to the specific "ANALYTIC STATS" headers of the box score tables
			const teamMatches = [...htmlContent.matchAll(/ANALYTIC STATS[\s\S]*?<a[^>]*idteam=[A-F0-9a-f]+[^>]*>([\s\S]*?)<\/a>/gi)];
			const homeTeamName = teamMatches[0] ? teamMatches[0][1].replace(/<[^>]+>/g, '').trim() : 'Home Team';
			const awayTeamName = teamMatches[1] ? teamMatches[1][1].replace(/<[^>]+>/g, '').trim() : 'Away Team';

			// Strip HTML tags before running the regex to match scores reliably
			const textOnly = htmlContent.replace(/<[^>]+>/g, ' ');
			const scoreMatch = textOnly.match(/(\d+)\s*(?:vs|-)\s*(\d+)/i);
			const homeScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
			const awayScore = scoreMatch ? parseInt(scoreMatch[2], 10) : 0;

			const mapPlayers = (rows) => {
				const playersList = [];
				for (const rHtml of rows) {
					const cells = getCells(rHtml);
					// Skip headers/totals rows by ensuring we have enough columns and the row has a time cell
					if (cells.length < 15) continue;

					// GBL player rows have a time played cell at index -2
					const minStr = cells[cells.length - 2];
					if (!/^\d{2}:\d{2}(:\d{2})?$/.test(minStr) || minStr === '00:00' || minStr === '00:00:00') continue;

					// Name is typically around index -17 (or index 1 / 2 depending on prefix columns)
					// Let's take the first non-numeric cell that is not empty and does not contain # (jersey number)
					let playerName = '';
					for (let i = 0; i < cells.length - 16; i++) {
						if (cells[i] && !cells[i].includes('#') && isNaN(Number(cells[i].replace(/:/g, '').replace(/#/g, '')))) {
							playerName = cells[i];
							break;
						}
					}
					if (!playerName) playerName = cells[0]; // fallback

					// Parse statistical components relative to the end of the cells array
					const parseFraction = (str) => {
						const parts = str.split('-').map(s => parseInt(s.trim(), 10));
						return {
							made: parts[0] || 0,
							att: parts[1] || 0
						};
					};

					const pts = parseInt(cells[cells.length - 16] || '0', 10);
					const fg2 = parseFraction(cells[cells.length - 15] || '0-0');
					const fg3 = parseFraction(cells[cells.length - 14] || '0-0');
					const ft = parseFraction(cells[cells.length - 13] || '0-0');

					const reb = parseInt(cells[cells.length - 12] || '0', 10);
					const dreb = parseInt(cells[cells.length - 11] || '0', 10);
					const oreb = parseInt(cells[cells.length - 10] || '0', 10);
					const ast = parseInt(cells[cells.length - 9] || '0', 10);
					const blk = parseInt(cells[cells.length - 8] || '0', 10);
					const blkA = parseInt(cells[cells.length - 7] || '0', 10);
					const pf = parseInt(cells[cells.length - 6] || '0', 10);
					const foulsDrawn = parseInt(cells[cells.length - 5] || '0', 10);
					const stl = parseInt(cells[cells.length - 4] || '0', 10);
					const tov = parseInt(cells[cells.length - 3] || '0', 10);

					playersList.push({
						playerId: playerName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
						playerName: playerName,
						statistics: {
							min: minStr,
							pts,
							fgm: fg2.made + fg3.made,
							fga: fg2.att + fg3.att,
							fg3m: fg3.made,
							fg3a: fg3.att,
							ftm: ft.made,
							fta: ft.att,
							oreb,
							dreb,
							reb,
							ast,
							stl,
							blk,
							tov,
							pf,
							plus_minus: 0 // GBL stats page doesn't always show +/-
						}
					});
				}
				return playersList;
			};

			const homePlayers = mapPlayers(statsTables[0]);
			const awayPlayers = mapPlayers(statsTables[1]);

			// Extract date from header metadata or fallback to current date
			const dateMatch = htmlContent.match(/(\d{2}-\d{2}-\d{4})/);
			let gameDate = '';
			if (dateMatch) {
				const parts = dateMatch[1].split('-');
				gameDate = `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
			} else {
				gameDate = `${yearPrefix}-11-15`; // Default fallback
			}

			return {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate,
				homeTeam: {
					teamId: homeTeamName.toUpperCase().substring(0, 4),
					teamName: homeTeamName,
					score: homeScore,
					players: homePlayers
				},
				awayTeam: {
					teamId: awayTeamName.toUpperCase().substring(0, 4),
					teamName: awayTeamName,
					score: awayScore,
					players: awayPlayers
				}
			};
		} catch (error) {
			console.error(`❌ [GblScraper] Error parsing game ${gameId}:`, error.message || error);
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
			gameDate: `${yearPrefix}-11-15`,
			homeTeam: {
				teamId: "OLY",
				teamName: "OLYMPIACOS",
				score: 82,
				statistics: {},
				players: [
					{
						playerId: "thomas-walkup",
						playerName: "Thomas Walkup",
						statistics: {
							min: "24:12",
							pts: 5,
							fgm: 1,
							fga: 6,
							fg3m: 1,
							fg3a: 5,
							ftm: 2,
							fta: 2,
							oreb: 2,
							dreb: 1,
							reb: 3,
							ast: 6,
							stl: 1,
							blk: 0,
							tov: 2,
							pf: 3,
							plus_minus: 6
						}
					}
				]
			},
			awayTeam: {
				teamId: "PAN",
				teamName: "PANATHINAIKOS AKTOR",
				score: 76,
				statistics: {},
				players: [
					{
						playerId: "cendi-osman",
						playerName: "Cendi Osman",
						statistics: {
							min: "36:34",
							pts: 23,
							fgm: 10,
							fga: 15,
							fg3m: 3,
							fg3a: 6,
							ftm: 0,
							fta: 0,
							oreb: 0,
							dreb: 4,
							reb: 4,
							ast: 2,
							stl: 0,
							blk: 0,
							tov: 0,
							pf: 2,
							plus_minus: -6
						}
					}
				]
			}
		};
	}
}
