import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { BslHarvester } from './harvesters/BslHarvester.mjs';

/**
 * @description Scraper for Turkish Basketbol Süper Ligi (BSL) domestic competition.
 * Fetches, caches, parses, and normalizes BSL game box score statistics from Proballers.
 */
export class BslScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.proballers.com');
		this.harvester = new BslHarvester(this);
		this.gameSlugs = [];
		this.gameUrlMap = new Map();
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Associates a game ID with its full Proballers URL during schedule harvesting.
	 * @param {string} gameId
	 * @param {string} url
	 */
	setGameUrl(gameId, url) {
		this.gameUrlMap.set(gameId, url);
	}

	/**
	 * @description Fetches all game slugs/IDs for BSL for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from a BSL gameId.
	 * BSL game ID is formatted as matchup-S{season}_{gameCode}, e.g. besiktas-vs-galatasaray-S2026_412345.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'S2026';

		// Extract season code segment from keyPart, e.g. "S2026" -> "2026" or "matchup-S2026" -> "2026"
		const segmentMatch = keyPart.match(/(?:-)?S(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2026';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'bsl',
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
		const { gameCode, seasonCode } = this.parseGameId(gameId);
		const key = `S${seasonCode}_${gameCode}`;
		return this.gameUrlMap.get(key) || this.gameUrlMap.get(gameId) || `https://www.proballers.com/basketball/game/${gameCode}/matchup`;
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
	 * @description Formats unified box score by loading BSL match pages with Playwright or using cached files.
	 * @param {string} gameId - Combined game identifier, e.g. 'besiktas-vs-galatasaray-S2026_412345'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Parse matchup team names from the gameId slug for mapping
		const slugParts = gameId.split('-S')[0].split('-vs-');
		const awaySlugExpected = slugParts[0] || '';
		const homeSlugExpected = slugParts[1] || '';

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/bsl', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [BslScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			const matchUrl = this.getGameEndpoint(gameId);
			console.log(`📡 [BslScraper] Loading BSL Boxscore from ${matchUrl}...`);

			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [BslScraper] Rate limit protection: sleeping 500ms...`);
			await new Promise(resolve => setTimeout(resolve, 500));

			const { chromium } = await import('playwright');
			const browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();

			try {
				await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });
				// Allow some time for table data to render
				await new Promise(resolve => setTimeout(resolve, 1000));
				htmlContent = await page.content();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [BslScraper] Saved raw BSL Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [BslScraper] Error fetching game ${gameId}:`, error.message || error);
				await browser.close();
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			} finally {
				await browser.close();
			}
		}

		try {
			return this.parseBslHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, competitionId, yearPrefix);
		} catch (error) {
			console.error(`❌ [BslScraper] Error parsing game HTML ${gameId}:`, error.message || error);
			return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
		}
	}

	/**
	 * @description Parses the player stats from an HTML table block using regex (zero-dependency).
	 * @param {string} htmlContent
	 * @param {string} homeSlugExpected
	 * @param {string} awaySlugExpected
	 * @param {string} gameId
	 * @param {string} competitionId
	 * @param {string} yearPrefix
	 * @returns {Object} Unified Europe BoxScore response
	 */
	parseBslHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, competitionId, yearPrefix) {
		const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
		let match;
		const tablesHtml = [];
		while ((match = tableRegex.exec(htmlContent)) !== null) {
			tablesHtml.push(match[1]);
		}

		// Helper to find preceding team name
		const findTeamNameForTable = (tableHtml, fullHtml) => {
			const idx = fullHtml.indexOf(tableHtml);
			if (idx === -1) return '';

			const searchBlock = fullHtml.substring(0, idx);
			const headingRegex = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
			let hMatch;
			let lastHeading = '';
			while ((hMatch = headingRegex.exec(searchBlock)) !== null) {
				lastHeading = hMatch[1].replace(/<[^>]+>/g, '').trim();
			}
			if (lastHeading && lastHeading.length > 2 && lastHeading.length < 50) {
				return lastHeading;
			}

			const titleRegex = /<(?:div|span|h4|h5|h6)[^>]*class="[^"]*(?:team-name|title_match|title|name|box-header|identity-title)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|h4|h5|h6)>/gi;
			let tMatch;
			let lastTitle = '';
			while ((tMatch = titleRegex.exec(searchBlock)) !== null) {
				lastTitle = tMatch[1].replace(/<[^>]+>/g, '').trim();
			}
			if (lastTitle && lastTitle.length > 2 && lastTitle.length < 50) {
				return lastTitle;
			}

			return '';
		};

		const getCells = (rowHtml) => {
			const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
			let m;
			const cells = [];
			while ((m = tdRegex.exec(rowHtml)) !== null) {
				cells.push(m[1].replace(/<[^>]+>/g, '').trim());
			}
			return cells;
		};

		const statsTables = [];

		for (const tHtml of tablesHtml) {
			// Find header row in this table to build column map
			const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
			let rMatch;
			const rowsHtml = [];
			while ((rMatch = rowRegex.exec(tHtml)) !== null) {
				rowsHtml.push(rMatch[1]);
			}

			if (rowsHtml.length < 2) continue;

			// Find header row
			let headerCells = [];
			let headerRowIndex = -1;
			for (let i = 0; i < rowsHtml.length; i++) {
				const cells = getCells(rowsHtml[i]);
				if (cells.some(c => c.toUpperCase().includes('MIN') || c.toUpperCase().includes('PTS'))) {
					headerCells = cells.map(c => c.toUpperCase().trim());
					headerRowIndex = i;
					break;
				}
			}

			if (headerRowIndex === -1) continue;

			// Create column index map
			const findCol = (labelKeywords) => {
				return headerCells.findIndex(h => labelKeywords.some(keyword => h === keyword || h.includes(keyword)));
			};

			const colMap = {
				min: findCol(['MIN', 'M']),
				pts: findCol(['PTS', 'PTS', 'POINTS']),
				reb: findCol(['REB', 'TOT', 'TR']),
				oreb: findCol(['OFF', 'OR', 'OREB']),
				dreb: findCol(['DEF', 'DR', 'DREB']),
				ast: findCol(['AST', 'AS', 'A']),
				stl: findCol(['STL', 'ST', 'S']),
				blk: findCol(['BLK', 'BS', 'B']),
				tov: findCol(['TO', 'TOV', 'T']),
				pf: findCol(['PF', 'F']),
				fgm: findCol(['FGM', 'FG']),
				fga: findCol(['FGA']),
				fg3m: findCol(['3PM', '3FG', '3M', '3P']),
				fg3a: findCol(['3PA', '3A']),
				ftm: findCol(['FTM', 'FT']),
				fta: findCol(['FTA'])
			};

			// If both PTS and MIN are not mapped, this is not a player stats table
			if (colMap.min === -1 && colMap.pts === -1) continue;

			const parsedRows = [];
			let totalsRow = null;

			// Parse player rows (everything after the header row)
			for (let i = headerRowIndex + 1; i < rowsHtml.length; i++) {
				const cells = getCells(rowsHtml[i]);
				if (cells.length < 5) continue;

				const rawName = cells[0];
				if (!rawName || rawName === 'Player' || rawName.includes('Player Name')) continue;

				const isTotals = rawName.toUpperCase().includes('TOTAL') || rawName.toUpperCase().includes('TEAM') || rawName.toUpperCase().includes('TOTALS');

				const valOf = (colIdx) => {
					if (colIdx === -1 || colIdx >= cells.length) return 0;
					return parseInt(cells[colIdx], 10) || 0;
				};

				const rawMin = colMap.min !== -1 ? cells[colMap.min] : '0:00';
				if (!isTotals && (!rawMin || rawMin === '0' || rawMin === '0:00' || rawMin === '00:00' || rawMin === '-')) {
					continue;
				}

				// Get statistics
				const pts = valOf(colMap.pts);
				const fgm = valOf(colMap.fgm);
				const fga = valOf(colMap.fga);
				const fg3m = valOf(colMap.fg3m);
				const fg3a = valOf(colMap.fg3a);
				const ftm = valOf(colMap.ftm);
				const fta = valOf(colMap.fta);
				const oreb = valOf(colMap.oreb);
				const dreb = valOf(colMap.dreb);
				const reb = colMap.reb !== -1 ? valOf(colMap.reb) : (oreb + dreb);
				const ast = valOf(colMap.ast);
				const stl = valOf(colMap.stl);
				const blk = valOf(colMap.blk);
				const tov = valOf(colMap.tov);
				const pf = valOf(colMap.pf);

				const rowData = {
					rawName,
					rawMin,
					pts,
					fgm,
					fga,
					fg3m,
					fg3a,
					ftm,
					fta,
					oreb,
					dreb,
					reb,
					ast,
					stl,
					blk,
					tov,
					pf,
					plus_minus: 0
				};

				if (isTotals) {
					totalsRow = rowData;
				} else {
					parsedRows.push(rowData);
				}
			}

			if (parsedRows.length > 0) {
				statsTables.push({
					candidateTeamName: findTeamNameForTable(tHtml, htmlContent),
					players: parsedRows,
					totals: totalsRow
				});
			}
		}

		if (statsTables.length < 2) {
			throw new Error(`[DOM Error] Found fewer than 2 statistics tables for BSL game ${gameId}.`);
		}

		// Helper to slugify and clean strings
		const slugify = (text) => {
			return String(text || '')
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, '')
				.trim()
				.replace(/[\s-]+/g, '-');
		};

		let homeTable = null;
		let awayTable = null;

		statsTables.forEach(table => {
			const candSlug = slugify(table.candidateTeamName);
			if (homeSlugExpected && candSlug.includes(homeSlugExpected)) {
				homeTable = table;
			} else if (awaySlugExpected && candSlug.includes(awaySlugExpected)) {
				awayTable = table;
			}
		});

		if (!homeTable || !awayTable) {
			homeTable = statsTables[1] || statsTables[0];
			awayTable = statsTables[0];
		}

		const homeTeamName = homeTable.candidateTeamName || 'Home Team';
		const awayTeamName = awayTable.candidateTeamName || 'Away Team';

		const homeScore = homeTable.totals ? homeTable.totals.pts : (homeTable.players.reduce((sum, p) => sum + p.pts, 0) || 0);
		const awayScore = awayTable.totals ? awayTable.totals.pts : (awayTable.players.reduce((sum, p) => sum + p.pts, 0) || 0);

		// Extract date from HTML content (Month DD, YYYY)
		const monthNames = {
			jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
			jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
		};
		let gameDate = '';
		const dateMatch = htmlContent.match(/([a-zA-Z]+)\s+(\d{1,2}),\s+(\d{4})/);
		if (dateMatch) {
			const m = monthNames[dateMatch[1].toLowerCase().substring(0, 3)];
			const d = String(dateMatch[2]).padStart(2, '0');
			const y = dateMatch[3];
			if (m) {
				gameDate = `${y}-${m}-${d}`;
			}
		}
		if (!gameDate) {
			gameDate = `${yearPrefix}-11-15`;
		}

		const mapPlayersList = (players) => {
			return players.map(p => ({
				playerId: slugify(p.rawName),
				playerName: p.rawName,
				statistics: {
					min: p.rawMin,
					pts: p.pts,
					fgm: p.fgm,
					fga: p.fga,
					fg3m: p.fg3m,
					fg3a: p.fg3a,
					ftm: p.ftm,
					fta: p.fta,
					oreb: p.oreb,
					dreb: p.dreb,
					reb: p.reb,
					ast: p.ast,
					stl: p.stl,
					blk: p.blk,
					tov: p.tov,
					pf: p.pf,
					plus_minus: p.plus_minus
				}
			}));
		};

		const mapTeamStats = (totals) => {
			if (!totals) return {};
			return {
				fgm: totals.fgm,
				fga: totals.fga,
				fg3m: totals.fg3m,
				fg3a: totals.fg3a,
				ftm: totals.ftm,
				fta: totals.fta,
				oreb: totals.oreb,
				dreb: totals.dreb,
				reb: totals.reb,
				ast: totals.ast,
				stl: totals.stl,
				blk: totals.blk,
				tov: totals.tov,
				pf: totals.pf
			};
		};

		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate,
			homeTeam: {
				teamId: homeTeamName.toUpperCase().substring(0, 4),
				teamName: homeTeamName,
				score: homeScore,
				statistics: mapTeamStats(homeTable.totals),
				players: mapPlayersList(homeTable.players)
			},
			awayTeam: {
				teamId: awayTeamName.toUpperCase().substring(0, 4),
				teamName: awayTeamName,
				score: awayScore,
				statistics: mapTeamStats(awayTable.totals),
				players: mapPlayersList(awayTable.players)
			}
		};
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
				teamId: "GALA",
				teamName: "Galatasaray",
				score: 85,
				statistics: {
					fgm: 30, fga: 60, fg3m: 10, fg3a: 25, ftm: 15, fta: 18,
					oreb: 8, dreb: 22, reb: 30, ast: 18, stl: 8, blk: 3, tov: 12, pf: 20
				},
				players: [
					{
						playerId: "sadik-emir-kabaca",
						playerName: "Sadik Emir Kabaca",
						statistics: {
							min: "28:36", pts: 14, fgm: 5, fga: 10, fg3m: 2, fg3a: 5, ftm: 2, fta: 2,
							oreb: 1, dreb: 4, reb: 5, ast: 6, stl: 2, blk: 1, tov: 2, pf: 3, plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "BESI",
				teamName: "Besiktas",
				score: 82,
				statistics: {
					fgm: 28, fga: 58, fg3m: 9, fg3a: 22, ftm: 17, fta: 20,
					oreb: 7, dreb: 20, reb: 27, ast: 15, stl: 6, blk: 2, tov: 14, pf: 22
				},
				players: [
					{
						playerId: "jonah-mathews",
						playerName: "Jonah Mathews",
						statistics: {
							min: "25:12", pts: 12, fgm: 4, fga: 8, fg3m: 1, fg3a: 3, ftm: 3, fta: 4,
							oreb: 2, dreb: 3, reb: 5, ast: 2, stl: 1, blk: 0, tov: 1, pf: 2, plus_minus: -8
						}
					}
				]
			}
		};
	}
}

export default BslScraper;
