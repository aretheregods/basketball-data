/**
 * @file CeblParser.mjs
 * @description Zero-dependency regex-based HTML and DOM parser for CEBL box score pages.
 */

import { BaseNormalizer } from '#utils';

/**
 * @description Helper to slugify and clean strings.
 * @param {string} text - The input text
 * @returns {string} - The slugified string
 */
export function slugify(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/[\s-]+/g, '-');
}

/**
 * @description Parses raw CEBL HTML content into clean JSON matching Canada BoxScore Schema.
 * @param {string} htmlContent - Raw HTML from CEBL game page
 * @param {string} gameId - Unique game ID
 * @param {string} season - Season year
 * @returns {Object} Cleaned and structured box score object
 * @throws {Error} If extracted player records are 0
 */
export function parseCeblHtml(htmlContent, gameId, season) {
	const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
	let match;
	const tablesHtml = [];
	while ((match = tableRegex.exec(htmlContent)) !== null) {
		tablesHtml.push(match[0]); // Keep the table tag to search classes
	}

	// Helper to find cells with class names from a row HTML
	const getCellsWithClasses = (rowHtml) => {
		const tdRegex = /<(?:td|th)([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi;
		let m;
		const cells = [];
		while ((m = tdRegex.exec(rowHtml)) !== null) {
			const attributes = m[1];
			const content = m[2].replace(/<[^>]+>/g, '').trim();
			const classMatch = attributes.match(/class="([^"]*)"/i);
			const className = classMatch ? classMatch[1] : '';
			cells.push({ className, content });
		}
		return cells;
	};

	// Helper to find preceding team name
	const findTeamNameForTable = (tableHtml, fullHtml) => {
		const idx = fullHtml.indexOf(tableHtml);
		if (idx === -1) return '';

		const searchBlock = fullHtml.substring(Math.max(0, idx - 1000), idx);
		const headingRegex = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
		let hMatch;
		let lastHeading = '';
		while ((hMatch = headingRegex.exec(searchBlock)) !== null) {
			const clean = hMatch[1].replace(/<[^>]+>/g, '').trim();
			if (clean && !clean.toLowerCase().includes('glossary') && !clean.toLowerCase().includes('stats')) {
				lastHeading = clean;
			}
		}
		if (lastHeading && lastHeading.length > 2 && lastHeading.length < 50) {
			return lastHeading;
		}
		return '';
	};

	const statsTables = [];

	for (const fullTableHtml of tablesHtml) {
		// Filter out tables that don't look like stats or boxscore tables
		const isBoxScoreTable = fullTableHtml.includes('stats-table') ||
			fullTableHtml.includes('boxscore-table') ||
			fullTableHtml.includes('col-min') ||
			fullTableHtml.includes('col-pts') ||
			fullTableHtml.includes('player-name');

		if (!isBoxScoreTable) continue;

		const tableContent = fullTableHtml.replace(/<table[^>]*>|<\/table>/gi, '');
		const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
		let rMatch;
		const rowsHtml = [];
		while ((rMatch = rowRegex.exec(tableContent)) !== null) {
			rowsHtml.push(rMatch[1]);
		}

		if (rowsHtml.length < 2) continue;

		// Map headers to column indices
		let headerCells = [];
		let headerRowIndex = -1;
		for (let i = 0; i < rowsHtml.length; i++) {
			const cells = getCellsWithClasses(rowsHtml[i]);
			const contents = cells.map(c => c.content.toUpperCase().trim());
			if (contents.some(c => c.includes('MIN') || c.includes('PTS') || c.includes('REB') || c.includes('AST'))) {
				headerCells = contents;
				headerRowIndex = i;
				break;
			}
		}

		const colMap = headerRowIndex !== -1 ? {
			player: headerCells.findIndex(h => h.includes('PLAYER') || h === 'NAME'),
			min: headerCells.findIndex(h => h.includes('MIN') || h === 'M'),
			pts: headerCells.findIndex(h => h.includes('PTS') || h === 'POINTS'),
			fgm: headerCells.findIndex(h => h === 'FGM' || h === 'FG'),
			fga: headerCells.findIndex(h => h === 'FGA'),
			fg3m: headerCells.findIndex(h => h === '3PM' || h === '3FG' || h === '3P'),
			fg3a: headerCells.findIndex(h => h === '3PA'),
			ftm: headerCells.findIndex(h => h === 'FTM'),
			fta: headerCells.findIndex(h => h === 'FTA'),
			oreb: headerCells.findIndex(h => h === 'OR' || h === 'OREB' || h === 'OFF'),
			dreb: headerCells.findIndex(h => h === 'DR' || h === 'DREB' || h === 'DEF'),
			reb: headerCells.findIndex(h => h === 'REB' || h === 'TOT' || h === 'TR'),
			ast: headerCells.findIndex(h => h === 'AST' || h === 'AS'),
			stl: headerCells.findIndex(h => h === 'STL' || h === 'ST'),
			blk: headerCells.findIndex(h => h === 'BLK' || h === 'BS'),
			tov: headerCells.findIndex(h => h === 'TO' || h === 'TOV' || h === 'TURNOVER'),
			pf: headerCells.findIndex(h => h === 'PF' || h === 'F' || h === 'FO')
		} : {};

		const parsedRows = [];
		let totalsRow = null;

		const extractCellVal = (cells, colIndex, classSubstr, fallbackIdx) => {
			if (colIndex !== undefined && colIndex !== -1 && colIndex < cells.length) {
				return cells[colIndex].content;
			}
			if (classSubstr) {
				const byClass = cells.find(c => c.className.includes(classSubstr));
				if (byClass) return byClass.content;
			}
			if (fallbackIdx !== undefined && fallbackIdx < cells.length) {
				return cells[fallbackIdx].content;
			}
			return '';
		};

		const extractIntCellVal = (cells, colIndex, classSubstr, fallbackIdx) => {
			const str = extractCellVal(cells, colIndex, classSubstr, fallbackIdx);
			return parseInt(str.trim(), 10) || 0;
		};

		const startIndex = headerRowIndex !== -1 ? headerRowIndex + 1 : 0;
		for (let i = startIndex; i < rowsHtml.length; i++) {
			const cells = getCellsWithClasses(rowsHtml[i]);
			if (cells.length < 3) continue;

			const rawName = extractCellVal(cells, colMap.player, 'player-name', 1);
			const rawMin = extractCellVal(cells, colMap.min, 'col-min', 2);

			if (!rawName) continue;

			// Check if totals row
			const isTotals = rawName.toUpperCase().includes('TOTAL') || rawName.toUpperCase().includes('TEAM') || rawName.toUpperCase().includes('TOTALS');

			if (!isTotals && (!rawMin || !rawMin.includes(':'))) {
				continue;
			}

			const pts = extractIntCellVal(cells, colMap.pts, 'col-pts', 3);
			const fgm = extractIntCellVal(cells, colMap.fgm, 'col-fgm', -1);
			const fga = extractIntCellVal(cells, colMap.fga, 'col-fga', -1);
			const fg3m = extractIntCellVal(cells, colMap.fg3m, 'col-fg3m', -1);
			const fg3a = extractIntCellVal(cells, colMap.fg3a, 'col-fg3a', -1);
			const ftm = extractIntCellVal(cells, colMap.ftm, 'col-ftm', -1);
			const fta = extractIntCellVal(cells, colMap.fta, 'col-fta', -1);
			const oreb = extractIntCellVal(cells, colMap.oreb, 'col-oreb', -1);
			const dreb = extractIntCellVal(cells, colMap.dreb, 'col-dreb', -1);
			const reb = extractIntCellVal(cells, colMap.reb, 'col-reb', 6);
			const ast = extractIntCellVal(cells, colMap.ast, 'col-ast', 7);
			const stl = extractIntCellVal(cells, colMap.stl, 'col-stl', 8);
			const blk = extractIntCellVal(cells, colMap.blk, 'col-blk', 9);
			const tov = extractIntCellVal(cells, colMap.tov, 'col-to', 10);
			const pf = extractIntCellVal(cells, colMap.pf, 'col-pf', 11);

			// Extract jersey number if any from name
			const cleanName = rawName.replace(/^\d+\s*/, '');

			const rowData = {
				rawName: cleanName,
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
				pf
			};

			if (isTotals) {
				totalsRow = rowData;
			} else {
				parsedRows.push(rowData);
			}
		}

		if (parsedRows.length > 0) {
			statsTables.push({
				candidateTeamName: findTeamNameForTable(fullTableHtml, htmlContent) || 'Team',
				players: parsedRows,
				totals: totalsRow
			});
		}
	}

	// Fail-Fast Assertion
	if (statsTables.length === 0) {
		throw new Error(`[DOM Error] Extracted 0 player records for CEBL game ${gameId}. Check DOM row selectors.`);
	}

	const homeTable = statsTables[0] || null;
	const awayTable = statsTables[1] || statsTables[0] || null;

	const homeTeamName = homeTable ? homeTable.candidateTeamName : 'Home Team';
	const awayTeamName = awayTable ? awayTable.candidateTeamName : 'Away Team';

	const homeScore = homeTable ? (homeTable.totals ? homeTable.totals.pts : homeTable.players.reduce((sum, p) => sum + p.pts, 0)) : 0;
	const awayScore = awayTable ? (awayTable.totals ? awayTable.totals.pts : awayTable.players.reduce((sum, p) => sum + p.pts, 0)) : 0;

	// Extract game date
	let gameDate = '';
	const dateMatch = htmlContent.match(/([a-zA-Z]+)\s+(\d{1,2}),\s+(\d{4})/);
	if (dateMatch) {
		const monthNames = {
			jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
			jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
		};
		const m = monthNames[dateMatch[1].toLowerCase().substring(0, 3)];
		const d = String(dateMatch[2]).padStart(2, '0');
		const y = dateMatch[3];
		if (m) {
			gameDate = `${y}-${m}-${d}`;
		}
	}
	if (!gameDate) {
		gameDate = `${season}-07-15`; // Default mid-summer date for CEBL
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
				plus_minus: 0
			}
		}));
	};

	return {
		gameId,
		season: String(season),
		gameDate,
		homeTeam: {
			teamId: homeTeamName.toUpperCase().substring(0, 4),
			teamName: homeTeamName,
			score: homeScore,
			players: homeTable ? mapPlayersList(homeTable.players) : []
		},
		awayTeam: {
			teamId: awayTeamName.toUpperCase().substring(0, 4),
			teamName: awayTeamName,
			score: awayScore,
			players: awayTable ? mapPlayersList(awayTable.players) : []
		}
	};
}

/**
 * @description Evaluates CEBL statistical tables natively inside browser context using Playwright.
 * @param {Object} page - Playwright page instance
 * @param {string} gameId - Unique game ID
 * @returns {Promise<Object[]>} List of player records
 */
export async function parseCeblDom(page, gameId) {
	const playerData = await page.evaluate(() => {
		const rows = Array.from(document.querySelectorAll('table.stats-table tbody tr, table.boxscore-table tbody tr'));

		return rows.map(row => {
			const nameEl = row.querySelector('.player-name, td:nth-child(2)');
			const minEl = row.querySelector('.col-min, td:nth-child(3)');

			if (!nameEl || !minEl) return null;

			const rawName = nameEl.innerText.trim();
			const rawMin = minEl.innerText.trim();

			// Skip non-player or team total summary rows
			if (!rawName || !rawMin || rawName.toUpperCase().includes('TOTAL') || !rawMin.includes(':')) {
				return null;
			}

			const ptsEl = row.querySelector('.col-pts, td:nth-child(4)');
			const rebEl = row.querySelector('.col-reb, td:nth-child(7)');
			const astEl = row.querySelector('.col-ast, td:nth-child(8)');
			const stlEl = row.querySelector('.col-stl, td:nth-child(9)');
			const blkEl = row.querySelector('.col-blk, td:nth-child(10)');
			const tovEl = row.querySelector('.col-to, td:nth-child(11)');
			const pfEl = row.querySelector('.col-pf, td:nth-child(12)');

			return {
				raw_name: rawName.replace(/^\d+\s*/, ''), // Strip jersey numbers
				raw_minutes: rawMin,
				pts: parseInt(ptsEl?.innerText.trim() || '0', 10),
				reb: parseInt(rebEl?.innerText.trim() || '0', 10),
				ast: parseInt(astEl?.innerText.trim() || '0', 10),
				stl: parseInt(stlEl?.innerText.trim() || '0', 10),
				blk: parseInt(blkEl?.innerText.trim() || '0', 10),
				tov: parseInt(tovEl?.innerText.trim() || '0', 10),
				pf: parseInt(pfEl?.innerText.trim() || '0', 10)
			};
		}).filter(Boolean);
	});

	// Fail-Fast Assertion
	if (!playerData || playerData.length === 0) {
		throw new Error(`[DOM Error] Extracted 0 player records for CEBL game ${gameId}. Check DOM row selectors.`);
	}

	return playerData;
}
