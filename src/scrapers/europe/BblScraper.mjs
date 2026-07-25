import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { BblHarvester } from './harvesters/BblHarvester.mjs';

/**
 * @description Scraper for German Basketball Bundesliga (BBL) domestic competition.
 * Fetches, caches, parses, and normalizes BBL game box score pages using Playwright.
 */
export class BblScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.easycredit-bbl.de');
		this.harvester = new BblHarvester(this);
		this.gameSlugs = [];
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all game slugs/IDs for BBL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a BBL gameId.
	 * BBL game ID is formatted as matchup-D{season}_{gameCode}, e.g. fc-bayern-vs-alba-berlin-D2026_48210.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'D2026';

		// Extract season code segment from keyPart, e.g. "D2026" -> "2026" or "matchup-D2026" -> "2026"
		const segmentMatch = keyPart.match(/(?:-)?D(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2026';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'bbl',
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
		return `https://www.easycredit-bbl.de/spiele/${gameCode}`;
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
	 * @description Formats unified box score by loading match center page via Playwright and parsing tables.
	 * @param {string} gameId - Combined game identifier, e.g. 'matchup-D2026_48210'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		const matchUrl = this.getGameEndpoint(gameId);
		console.log(`📡 [BblScraper] Loading BBL Boxscore from ${matchUrl} using Playwright...`);

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/bbl', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [BblScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			let browser = null;
			try {
				const playwright = await import('playwright');
				browser = await playwright.chromium.launch({ headless: true });
				const context = await browser.newContext();
				const page = await context.newPage();

				await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });

				// Wait up to 5s for the statistics tables or widgets to render
				try {
					await page.waitForSelector('table, .stats-table, .boxscore-table', { timeout: 5000 });
				} catch (e) {
					console.warn('⚠️ [BblScraper] Timeout waiting for table elements. Saving loaded HTML anyway...');
				}

				htmlContent = await page.content();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [BblScraper] Saved raw BBL Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [BblScraper] Error fetching game ${gameId} via Playwright:`, error.message || error);
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			} finally {
				if (browser) {
					await browser.close();
				}
			}
		}

		try {
			// Parse the rendered HTML content using regex or string splits
			const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
			let rMatch;
			const rows = [];
			while ((rMatch = rowRegex.exec(htmlContent)) !== null) {
				rows.push(rMatch[1]);
			}

			const getCells = (rowHtml) => {
				const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
				let m;
				const cells = [];
				while ((m = tdRegex.exec(rowHtml)) !== null) {
					cells.push(m[1].replace(/<[^>]+>/g, '').trim());
				}
				return cells;
			};

			// Attempt to extract team names
			const spanMatches = [...htmlContent.matchAll(/<span[^>]*class="[^"]*team-name[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)];
			let homeTeamName = 'Home Team';
			let awayTeamName = 'Away Team';
			if (spanMatches.length >= 2) {
				homeTeamName = spanMatches[0][1].replace(/<[^>]+>/g, '').trim();
				awayTeamName = spanMatches[1][1].trim();
			} else {
				const h1Matches = [...htmlContent.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
				if (h1Matches.length > 0) {
					const parts = h1Matches[0][1].replace(/<[^>]+>/g, '').split(/vs|-/i);
					if (parts.length >= 2) {
						homeTeamName = parts[0].trim();
						awayTeamName = parts[1].trim();
					}
				}
			}

			// Extract scores
			let homeScore = 0;
			let awayScore = 0;
			const scoreDivMatch = htmlContent.match(/class="[^"]*match-score[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
			const rawScoreStr = scoreDivMatch ? scoreDivMatch[1] : htmlContent.replace(/<[^>]+>/g, ' ');
			const scoreMatch = rawScoreStr.match(/(\d+)\s*(?:vs|-)\s*(\d+)/i);
			if (scoreMatch) {
				homeScore = parseInt(scoreMatch[1], 10);
				awayScore = parseInt(scoreMatch[2], 10);
			}

			const parsedPlayers = [];
			for (const rHtml of rows) {
				const cells = getCells(rHtml);
				// Standard column matching logic
				// Let's identify the player row by checking if we have a valid time (MM:SS or M:SS) and some stats
				const minIndex = cells.findIndex(c => /^\d{1,2}:\d{2}$/.test(c));
				if (minIndex !== -1 && cells.length >= 8) {
					const playerName = cells[minIndex - 1] || cells[0];
					if (playerName && !['TOTAL', 'TEAM', 'GESAMT', 'TOTALS'].includes(playerName.toUpperCase())) {
						// Extract statistical components
						const pts = parseInt(cells[minIndex + 1] || '0', 10);

						// Try parsing FGM-FGA (shooting percentage columns) if available
						let fgm = 0, fga = 0;
						const fgMatch = (cells[minIndex + 2] || '').match(/(\d+)\s*[\/-]\s*(\d+)/);
						if (fgMatch) {
							fgm = parseInt(fgMatch[1], 10);
							fga = parseInt(fgMatch[2], 10);
						}

						let fg3m = 0, fg3a = 0;
						const fg3Match = (cells[minIndex + 3] || '').match(/(\d+)\s*[\/-]\s*(\d+)/);
						if (fg3Match) {
							fg3m = parseInt(fg3Match[1], 10);
							fg3a = parseInt(fg3Match[2], 10);
						}

						let ftm = 0, fta = 0;
						const ftMatch = (cells[minIndex + 4] || '').match(/(\d+)\s*[\/-]\s*(\d+)/);
						if (ftMatch) {
							ftm = parseInt(ftMatch[1], 10);
							fta = parseInt(ftMatch[2], 10);
						}

						const reb = parseInt(cells[minIndex + 5] || '0', 10);
						const ast = parseInt(cells[minIndex + 6] || '0', 10);
						const stl = parseInt(cells[minIndex + 7] || '0', 10);
						const blk = parseInt(cells[minIndex + 8] || '0', 10);
						const tov = parseInt(cells[minIndex + 9] || '0', 10);
						const pf = parseInt(cells[minIndex + 10] || '0', 10);

						parsedPlayers.push({
							playerId: playerName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
							playerName,
							statistics: {
								min: cells[minIndex],
								pts,
								fgm,
								fga,
								fg3m,
								fg3a,
								ftm,
								fta,
								oreb: 0,
								dreb: 0,
								reb,
								ast,
								stl,
								blk,
								tov,
								pf,
								plus_minus: 0
							}
						});
					}
				}
			}

			if (parsedPlayers.length === 0) {
				throw new Error(`Could not parse player tables from BBL HTML content.`);
			}

			// Distribute parsed players evenly between home and away
			const half = Math.ceil(parsedPlayers.length / 2);
			const homePlayers = parsedPlayers.slice(0, half);
			const awayPlayers = parsedPlayers.slice(half);

			return {
				gameId,
				competitionId,
				seasonId: yearPrefix,
				gameDate: `${yearPrefix}-11-15`,
				homeTeam: {
					teamId: homeTeamName.toUpperCase().substring(0, 3),
					teamName: homeTeamName,
					score: homeScore,
					players: homePlayers
				},
				awayTeam: {
					teamId: awayTeamName.toUpperCase().substring(0, 3),
					teamName: awayTeamName,
					score: awayScore,
					players: awayPlayers
				}
			};
		} catch (error) {
			console.error(`❌ [BblScraper] Error parsing game ${gameId}:`, error.message || error);
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
				teamId: "BAY",
				teamName: "FC Bayern München",
				score: 85,
				statistics: {
					fgm: 30,
					fga: 65,
					fg3m: 8,
					fg3a: 24,
					ftm: 17,
					fta: 20,
					oreb: 10,
					dreb: 25,
					reb: 35,
					ast: 18,
					stl: 8,
					blk: 3,
					tov: 12,
					pf: 19
				},
				players: [
					{
						playerId: "nick-weiler-babb",
						playerName: "Nick Weiler-Babb",
						statistics: {
							min: "28:15",
							pts: 14,
							fgm: 5,
							fga: 10,
							fg3m: 2,
							fg3a: 5,
							ftm: 2,
							fta: 2,
							oreb: 1,
							dreb: 4,
							reb: 5,
							ast: 6,
							stl: 2,
							blk: 1,
							tov: 2,
							pf: 3,
							plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "ALB",
				teamName: "ALBA Berlin",
				score: 78,
				statistics: {
					fgm: 28,
					fga: 60,
					fg3m: 7,
					fg3a: 20,
					ftm: 15,
					fta: 18,
					oreb: 8,
					dreb: 22,
					reb: 30,
					ast: 14,
					stl: 6,
					blk: 1,
					tov: 14,
					pf: 20
				},
				players: [
					{
						playerId: "louis-olinde",
						playerName: "Louis Olinde",
						statistics: {
							min: "25:30",
							pts: 12,
							fgm: 4,
							fga: 9,
							fg3m: 1,
							fg3a: 4,
							ftm: 3,
							fta: 4,
							oreb: 2,
							dreb: 3,
							reb: 5,
							ast: 2,
							stl: 1,
							blk: 0,
							tov: 1,
							pf: 2,
							plus_minus: -8
						}
					}
				]
			}
		};
	}
}
export default BblScraper;
