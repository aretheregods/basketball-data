import fs from 'fs/promises';
import path from 'path';
import { HTTPClient } from '#utils';
import { AbaHarvester } from './harvesters/AbaHarvester.mjs';

/**
 * @description Scraper for AdmiralBet ABA League (Adriatic Basketball) domestic competition.
 * Fetches, caches, parses, and normalizes ABA game box score statistics from aba-liga.com.
 */
export class AbaScraper extends HTTPClient {
	/**
	 * @constructor
	 */
	constructor() {
		super('https://www.aba-liga.com');
		this.harvester = new AbaHarvester(this);
		this.gameSlugs = [];
		this.bypassNetwork = process.env.NODE_ENV === 'test';
	}

	/**
	 * @description Fetches all game slugs/IDs for ABA for a given season.
	 * @param {string|number} year - The season year
	 * @returns {Promise<string[]>} List of game slugs
	 */
	async getSeasonGameSlugs(year) {
		const slugs = await this.harvester.getSeasonGameSlugs(year);
		this.gameSlugs = slugs;
		return slugs;
	}

	/**
	 * @description Parses the competition, season, and gamecode from an ABA gameId.
	 * ABA game ID is formatted as matchup-V{season}_{gameCode}, e.g. partizan-vs-crvena-zvezda-V2025_123.
	 * @param {string} gameId
	 * @returns {{ competitionId: string, seasonCode: string, gameCode: string, yearPrefix: string }}
	 */
	parseGameId(gameId) {
		const clean = String(gameId || '').trim();
		const parts = clean.split('_');
		const gameCode = parts[1] || '1';
		const keyPart = parts[0] || 'V2025';

		// Extract season code segment from keyPart, e.g. "V2025" -> "2025" or "matchup-V2025" -> "2025"
		const segmentMatch = keyPart.match(/(?:-)?V(\d{4})$/i);
		const seasonCode = segmentMatch ? segmentMatch[1] : '2025';
		const yearPrefix = seasonCode;

		return {
			competitionId: 'aba',
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
		const twoDigitSeason = seasonCode.slice(-2);
		return `https://www.aba-liga.com/match/${gameCode}/${twoDigitSeason}/1/Boxscore/`;
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
	 * @description Formats unified box score by loading ABA match pages with Playwright.
	 * @param {string} gameId - Combined game identifier, e.g. 'partizan-vs-crvena-zvezda-V2025_123'
	 * @returns {Promise<Object>} Unified Europe BoxScore response
	 */
	async getUnifiedBoxScore(gameId) {
		const { competitionId, yearPrefix, gameCode } = this.parseGameId(gameId);

		// If in test mode, bypass real network calls and return mock data
		if (this.bypassNetwork) {
			return this.getMockUnifiedBoxScore(gameId);
		}

		// Parse matchup team names from the gameId slug for mapping
		const slugParts = gameId.split('-V')[0].split('-vs-');
		const awaySlugExpected = slugParts[0] || '';
		const homeSlugExpected = slugParts[1] || '';

		// Set up directories for side-cache HTML saving
		const htmlCacheDir = path.resolve('data/raw/europe/aba', String(yearPrefix));
		await fs.mkdir(htmlCacheDir, { recursive: true });
		const htmlCachePath = path.join(htmlCacheDir, `${gameCode}.html`);

		let htmlContent = '';
		try {
			// Check if we already have the raw HTML cached locally
			const stats = await fs.stat(htmlCachePath);
			if (stats.size > 0) {
				console.log(`⏭️ [AbaScraper] HTML cache found for game ${gameCode}. Reading from disk...`);
				htmlContent = await fs.readFile(htmlCachePath, 'utf8');
			}
		} catch (e) {
			// Cache miss, proceed to fetch
		}

		if (!htmlContent) {
			const matchUrl = this.getGameEndpoint(gameId);
			console.log(`📡 [AbaScraper] Loading ABA Boxscore from ${matchUrl}...`);

			// Inject 500ms delay to prevent rate limiting
			console.log(`⏳ [AbaScraper] Rate limit protection: sleeping 500ms...`);
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
				console.log(`💾 [AbaScraper] Saved raw ABA Boxscore HTML to ${htmlCachePath}`);
			} catch (error) {
				console.error(`❌ [AbaScraper] Error fetching game ${gameId}:`, error.message || error);
				await browser.close();
				return this.getUnplayedSkeleton(gameId, competitionId, yearPrefix);
			} finally {
				await browser.close();
			}
		}

		try {
			return this.parseAbaHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, competitionId, yearPrefix);
		} catch (error) {
			console.error(`❌ [AbaScraper] Error parsing game HTML ${gameId}:`, error.message || error);
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
	parseAbaHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, competitionId, yearPrefix) {
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
			const headingRegex = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
			let hMatch;
			let lastHeading = '';
			const banned = ['match', 'player stats', 'team stats', 'results', 'index', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'head-to-head', 'home team', 'away team', 'overall'];
			while ((hMatch = headingRegex.exec(searchBlock)) !== null) {
				const content = hMatch[1].replace(/<[^>]+>/g, '').trim();
				if (content.length > 2 && content.length < 50 && !banned.some(b => content.toLowerCase().includes(b))) {
					lastHeading = content;
				}
			}
			if (lastHeading) {
				return lastHeading;
			}

			const titleRegex = /<(?:div|span|h4|h5|h6)[^>]*class="[^"]*(?:team-name|title_match|title|name)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|h4|h5|h6)>/gi;
			let tMatch;
			let lastTitle = '';
			while ((tMatch = titleRegex.exec(searchBlock)) !== null) {
				const content = tMatch[1].replace(/<[^>]+>/g, '').trim();
				if (content.length > 2 && content.length < 50 && !banned.some(b => content.toLowerCase().includes(b))) {
					lastTitle = content;
				}
			}
			if (lastTitle) {
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
			const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
			let rMatch;
			const parsedRows = [];
			let totalsRow = null;

			while ((rMatch = rowRegex.exec(tHtml)) !== null) {
				const cells = getCells(rMatch[1]);
				if (cells.length < 12) continue;

				const rawName = cells[1];
				const rawMin = cells[2];
				if (!rawName) continue;

				const isTotals = rawName.toUpperCase().includes('TOTAL') || rawName.toUpperCase().includes('TEAM') || rawName.toUpperCase().includes('TOTALS');

				if (!isTotals && (!rawMin || !rawMin.includes(':'))) {
					continue;
				}

				const parseFrac = (str) => {
					const parts = str.split('/').map(s => parseInt(s.trim(), 10));
					return {
						made: parts[0] || 0,
						att: parts[1] || 0
					};
				};

				const pt2 = parseFrac(cells[4] || '0/0');
				const pt3 = parseFrac(cells[7] || '0/0');
				const ft = parseFrac(cells[10] || '0/0');

				const rowData = {
					rawName: rawName.replace(/^\d+\s*/, ''),
					rawMin,
					pts: parseInt(cells[3] || '0', 10),
					fgm: pt2.made + pt3.made,
					fga: pt2.att + pt3.att,
					fg3m: pt3.made,
					fg3a: pt3.att,
					ftm: ft.made,
					fta: ft.att,
					oreb: parseInt(cells[13] || '0', 10),
					dreb: parseInt(cells[14] || '0', 10),
					reb: parseInt(cells[15] || '0', 10),
					ast: parseInt(cells[16] || '0', 10),
					stl: parseInt(cells[17] || '0', 10),
					blk: parseInt(cells[19] || '0', 10),
					tov: parseInt(cells[18] || '0', 10),
					pf: parseInt(cells[21] || '0', 10),
					plus_minus: parseInt(cells[23] || '0', 10)
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
			throw new Error(`[DOM Error] Found fewer than 2 statistics tables for ABA game ${gameId}.`);
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

		// Extract date from HTML content (DD.MM.YYYY)
		let gameDate = '';
		const dateMatch = htmlContent.match(/(\d{2})\.(\d{2})\.(\d{4})/);
		if (dateMatch) {
			gameDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
		} else {
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
				teamId: "CRVE",
				teamName: "Crvena Zvezda",
				score: 85,
				statistics: {
					fgm: 30, fga: 60, fg3m: 10, fg3a: 25, ftm: 15, fta: 18,
					oreb: 8, dreb: 22, reb: 30, ast: 18, stl: 8, blk: 3, tov: 12, pf: 20
				},
				players: [
					{
						playerId: "filip-rebraca",
						playerName: "Filip Rebraca",
						statistics: {
							min: "28:36", pts: 14, fgm: 5, fga: 10, fg3m: 2, fg3a: 5, ftm: 2, fta: 2,
							oreb: 1, dreb: 4, reb: 5, ast: 6, stl: 2, blk: 1, tov: 2, pf: 3, plus_minus: 8
						}
					}
				]
			},
			awayTeam: {
				teamId: "PART",
				teamName: "Partizan Mozzart Bet",
				score: 82,
				statistics: {
					fgm: 28, fga: 58, fg3m: 9, fg3a: 22, ftm: 17, fta: 20,
					oreb: 7, dreb: 20, reb: 27, ast: 15, stl: 6, blk: 2, tov: 14, pf: 22
				},
				players: [
					{
						playerId: "antonio-sikiric",
						playerName: "Antonio Sikiric",
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

export default AbaScraper;
