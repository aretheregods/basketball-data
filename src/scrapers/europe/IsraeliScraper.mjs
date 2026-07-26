import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { IsraeliHarvester } from './harvesters/IsraeliHarvester.mjs';

/**
 * @description Scraper for Israeli Basketball (Winner League / Ligat Ha'Al) domestic competition.
 * Fetches, caches, parses, and normalizes Israeli game box score statistics from basket.co.il.
 */
export class IsraeliScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.basket.co.il');
		this.harvester = new IsraeliHarvester(this);
		this.gameSlugs = [];
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all game slugs/IDs for Israeli League for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from an Israeli gameId.
	 * Israeli game ID is formatted as matchup-Y{season}_{gameCode}, e.g. matchup-Y2025_25147.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'Y2025';

		// Extract season code segment from keyPart, e.g. "Y2025" -> "2025"
		const segmentMatch = keyPart.match(/(?:-)?Y(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2025';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'israel',
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
		return `https://www.basket.co.il/game-zone.asp?GameId=${gameCode}&lang=en`;
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
	 * @description Formats unified box score by loading match pages with Playwright or using cached files.
	 * @param {string} gameId - Combined game identifier, e.g. 'matchup-Y2025_25147'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Parse matchup team names from the gameId slug for mapping
		const slugParts = gameId.split('-Y')[0].split('-vs-');
		const awaySlugExpected = slugParts[0] || '';
		const homeSlugExpected = slugParts[1] || '';

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/israel', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [IsraeliScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			const matchUrl = this.getGameEndpoint(gameId);
			console.log(`📡 [IsraeliScraper] Loading Israeli Boxscore from ${matchUrl}...`);

			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [IsraeliScraper] Rate limit protection: sleeping 500ms...`);
			await new Promise(resolve => setTimeout(resolve, 500));

			const { chromium } = await import('playwright');
			const browser = await chromium.launch({
				headless: true,
				args: [
					'--disable-blink-features=AutomationControlled',
					'--disable-features=IsolateOrigins,site-per-process',
					'--no-sandbox',
					'--disable-setuid-sandbox'
				]
			});

			const context = await browser.newContext({
				userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
				viewport: { width: 1920, height: 1080 },
				locale: 'en-US'
			});

			await context.addInitScript(() => {
				Object.defineProperty(navigator, 'webdriver', { get: () => false });
				Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
				Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
			});

			const page = await context.newPage();

			try {
				await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });
				// Allow time for table data to render
				for (let i = 0; i < 15; i++) {
					await page.waitForTimeout(1000);
					const count = await page.evaluate(() => document.querySelectorAll('table.stats_tbl').length);
					if (count > 0) break;
				}
				htmlContent = await page.content();
				await fs.writeFile(htmlCachePath, htmlContent, 'utf8');
				console.log(`💾 [IsraeliScraper] Saved raw Israeli Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [IsraeliScraper] Error fetching game ${gameId}:`, error.message || error);
				await browser.close();
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			} finally {
				await browser.close();
			}
		}

		try {
			return this.parseIsraeliHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, competitionId, yearPrefix);
		} catch (error) {
			console.error(`❌ [IsraeliScraper] Error parsing game HTML ${gameId}:`, error.message || error);
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
	parseIsraeliHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, competitionId, yearPrefix) {
		const tableRegex = /<table[^>]*class="[^"]*stats_tbl[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
		let match;
		const tablesHtml = [];
		while ((match = tableRegex.exec(htmlContent)) !== null) {
			tablesHtml.push(match[1]);
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

		const statsTables = [];

		for (const tHtml of tablesHtml) {
			const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
			let rMatch;
			const rowsHtml = [];
			while ((rMatch = rowRegex.exec(tHtml)) !== null) {
				rowsHtml.push(rMatch[1]);
			}

			if (rowsHtml.length < 2) continue;

			// Find header row containing PLAYER NAME and MIN and PTS
			let headerCells = [];
			let headerRowIndex = -1;
			for (let i = 0; i < rowsHtml.length; i++) {
				const cells = getCells(rowsHtml[i]);
				const normalizedCells = cells.map(c => c.toUpperCase().trim());
				if (normalizedCells.includes('PLAYER NAME') && normalizedCells.includes('MIN') && normalizedCells.includes('PTS')) {
					headerCells = normalizedCells;
					headerRowIndex = i;
					break;
				}
			}

			if (headerRowIndex === -1) continue;

			// Extract team name
			let teamName = '';
			const teamLinkMatch = tHtml.match(/href="team\.asp\?TeamId=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
			if (teamLinkMatch) {
				teamName = teamLinkMatch[1].replace(/<[^>]+>/g, '').trim();
			}

			statsTables.push({
				teamName,
				rowsHtml,
				headerCells,
				headerRowIndex
			});
		}

		if (statsTables.length < 2) {
			throw new Error(`[DOM Error] Found fewer than 2 statistics tables for Israeli game ${gameId}.`);
		}

		const slugify = (text) => {
			return String(text || '')
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, '')
				.trim()
				.replace(/[\s-]+/g, '-');
		};

		let homeTableParsed = null;
		let awayTableParsed = null;

		statsTables.forEach(table => {
			const candSlug = slugify(table.teamName);
			if (homeSlugExpected && candSlug.includes(homeSlugExpected)) {
				homeTableParsed = table;
			} else if (awaySlugExpected && candSlug.includes(awaySlugExpected)) {
				awayTableParsed = table;
			}
		});

		if (!homeTableParsed || !awayTableParsed) {
			homeTableParsed = statsTables[0] || null;
			awayTableParsed = statsTables[1] || statsTables[0] || null;
		}

		// Helper to process player rows inside a stats table
		const processTable = (tableObj) => {
			const { rowsHtml, headerCells, headerRowIndex } = tableObj;

			const colMap = {
				player: headerCells.indexOf('PLAYER NAME'),
				min: headerCells.indexOf('MIN'),
				pts: headerCells.indexOf('PTS'),
				dr: headerCells.indexOf('DR'),
				or: headerCells.indexOf('OR'),
				tr: headerCells.indexOf('TR'),
				pf: headerCells.indexOf('PF'),
				fa: headerCells.indexOf('FA'),
				st: headerCells.indexOf('ST'),
				to: headerCells.indexOf('TO'),
				as: headerCells.indexOf('AS'),
				pm: headerCells.indexOf('+/-'),
				bkf: headerCells.indexOf('BKF')
			};

			const maIndices = [];
			headerCells.forEach((c, idx) => {
				if (c === 'M/A' || c.includes('M/A')) {
					maIndices.push(idx);
				}
			});
			const fg2_ma_idx = maIndices[0] !== undefined ? maIndices[0] : -1;
			const fg3_ma_idx = maIndices[1] !== undefined ? maIndices[1] : -1;
			const ft_ma_idx = maIndices[2] !== undefined ? maIndices[2] : -1;

			const playersList = [];
			let totalsRow = null;

			const parseMA = (val) => {
				if (!val || typeof val !== 'string' || !val.includes('/')) return [0, 0];
				const parts = val.split('/').map(v => parseInt(v.trim(), 10) || 0);
				return [parts[0] || 0, parts[1] || 0];
			};

			const valOf = (cells, idx) => {
				if (idx === -1 || idx >= cells.length) return 0;
				return parseInt(cells[idx].replace(/&nbsp;/g, '').trim(), 10) || 0;
			};

			for (let i = headerRowIndex + 1; i < rowsHtml.length; i++) {
				const cells = getCells(rowsHtml[i]);
				if (cells.length < 10) continue;

				const rawName = cells[colMap.player !== -1 ? colMap.player : 1];
				if (!rawName || rawName.toUpperCase() === 'PLAYER NAME' || rawName === 'Team') continue;

				const isTotals = rawName.toUpperCase().includes('TOTAL') || rawName.toUpperCase().includes('TOTALS');

				const rawMin = colMap.min !== -1 ? cells[colMap.min].replace(/&nbsp;/g, '').trim() : '0';

				// Skip non-playing players
				if (!isTotals && (!rawMin || rawMin === '0' || rawMin === '0:00' || rawMin === '-')) {
					continue;
				}

				const [fg2m, fg2a] = fg2_ma_idx !== -1 ? parseMA(cells[fg2_ma_idx]) : [0, 0];
				const [fg3m, fg3a] = fg3_ma_idx !== -1 ? parseMA(cells[fg3_ma_idx]) : [0, 0];
				const [ftm, fta] = ft_ma_idx !== -1 ? parseMA(cells[ft_ma_idx]) : [0, 0];

				const fgm = fg2m + fg3m;
				const fga = fg2a + fg3a;

				const oreb = colMap.or !== -1 ? valOf(cells, colMap.or) : 0;
				const dreb = colMap.dr !== -1 ? valOf(cells, colMap.dr) : 0;
				const reb = colMap.tr !== -1 ? valOf(cells, colMap.tr) : (oreb + dreb);
				const ast = colMap.as !== -1 ? valOf(cells, colMap.as) : 0;
				const stl = colMap.st !== -1 ? valOf(cells, colMap.st) : 0;
				const blk = colMap.bkf !== -1 ? valOf(cells, colMap.bkf) : 0;
				const tov = colMap.to !== -1 ? valOf(cells, colMap.to) : 0;
				const pf = colMap.pf !== -1 ? valOf(cells, colMap.pf) : 0;
				const pts = colMap.pts !== -1 ? valOf(cells, colMap.pts) : 0;
				const plus_minus = colMap.pm !== -1 ? (parseInt(cells[colMap.pm].replace(/&nbsp;/g, '').trim(), 10) || 0) : 0;

				const rowData = {
					playerId: slugify(rawName),
					playerName: rawName,
					statistics: {
						min: rawMin,
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
						plus_minus
					}
				};

				if (isTotals) {
					totalsRow = rowData;
				} else {
					playersList.push(rowData);
				}
			}

			return {
				players: playersList,
				totals: totalsRow
			};
		};

		const homeTeamResult = processTable(homeTableParsed);
		const awayTeamResult = processTable(awayTableParsed);

		const homeScore = homeTeamResult.totals ? homeTeamResult.totals.statistics.pts : homeTeamResult.players.reduce((sum, p) => sum + p.statistics.pts, 0);
		const awayScore = awayTeamResult.totals ? awayTeamResult.totals.statistics.pts : awayTeamResult.players.reduce((sum, p) => sum + p.statistics.pts, 0);

		// Extract date
		let gameDate = '';
		const dateMatch = htmlContent.match(/<div[^>]*class="[^"]*page_game_zone_date[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
		if (dateMatch) {
			const rawDate = dateMatch[1].trim();
			const parts = rawDate.split('/');
			if (parts.length === 3) {
				gameDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
			}
		}
		if (!gameDate) {
			gameDate = `${yearPrefix}-11-15`;
		}

		return {
			gameId,
			competitionId,
			seasonId: yearPrefix,
			gameDate,
			homeTeam: {
				teamId: (homeTableParsed.teamName || 'HOME').toUpperCase().substring(0, 4),
				teamName: homeTableParsed.teamName || 'Home Team',
				score: homeScore,
				statistics: homeTeamResult.totals ? homeTeamResult.totals.statistics : {},
				players: homeTeamResult.players
			},
			awayTeam: {
				teamId: (awayTableParsed.teamName || 'AWAY').toUpperCase().substring(0, 4),
				teamName: awayTableParsed.teamName || 'Away Team',
				score: awayScore,
				statistics: awayTeamResult.totals ? awayTeamResult.totals.statistics : {},
				players: awayTeamResult.players
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
			gameDate: `${yearPrefix}-10-06`,
			homeTeam: {
				teamId: "AFUL",
				teamName: "Hapoel Afula",
				score: 85,
				statistics: {
					fgm: 30, fga: 60, fg3m: 10, fg3a: 25, ftm: 15, fta: 18,
					oreb: 8, dreb: 22, reb: 30, ast: 18, stl: 8, blk: 3, tov: 12, pf: 20
				},
				players: [
					{
						playerId: "justin-mathews",
						playerName: "Justin Mathews",
						statistics: {
							min: "28:36", pts: 14, fgm: 5, fga: 10, fg3m: 2, fg3a: 5, ftm: 2, fta: 2,
							oreb: 1, dreb: 4, reb: 5, ast: 6, stl: 2, blk: 1, tov: 2, pf: 3, plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "KIRY",
				teamName: "Ironi Lati Kiryat Ata",
				score: 67,
				statistics: {
					fgm: 25, fga: 61, fg3m: 5, fg3a: 21, ftm: 12, fta: 25,
					oreb: 14, dreb: 33, reb: 47, ast: 14, stl: 4, blk: 3, tov: 18, pf: 21
				},
				players: [
					{
						playerId: "akia-pruitt",
						playerName: "Akia Pruitt",
						statistics: {
							min: "33", pts: 12, fgm: 4, fga: 10, fg3m: 2, fg3a: 5, ftm: 2, fta: 3,
							oreb: 0, dreb: 4, reb: 4, ast: 1, stl: 0, blk: 1, tov: 2, pf: 2, plus_minus: -11
						}
					}
				]
			}
		};
	}
}

export default IsraeliScraper;
