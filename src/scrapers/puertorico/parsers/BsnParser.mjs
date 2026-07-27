/**
 * @file BsnParser.mjs
 * @description Robust zero-dependency regex-based HTML parser for Proballers BSN box score pages.
 */

/**
 * @description Helper to slugify and clean strings.
 * @param {string} text - The input text
 * @returns {string} - The slugified string
 */
export function slugify(text) {
	return String(text || '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/[\s-]+/g, '-');
}

/**
 * @description Parses raw Proballers HTML content into clean JSON matching Puerto Rico BoxScore Schema.
 * @param {string} htmlContent - Raw HTML from Proballers game page
 * @param {string} homeSlugExpected - Expected home team slug segment
 * @param {string} awaySlugExpected - Expected away team slug segment
 * @param {string} gameId - Unique game ID
 * @param {string} season - Season year
 * @returns {Object} Cleaned and structured box score object
 */
export function parseBsnHtml(htmlContent, homeSlugExpected, awaySlugExpected, gameId, season) {
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
		while ((hMatch = headingRegex.exec(searchBlock)) !== null) {
			const clean = hMatch[1].replace(/<[^>]+>/g, '').trim();
			if (clean && !clean.toLowerCase().includes('glossary') && !clean.toLowerCase().includes('stats') && !clean.toLowerCase().includes('factor') && !clean.toLowerCase().includes('quarter') && !clean.toLowerCase().includes('impact')) {
				lastHeading = clean;
			}
		}
		if (lastHeading && lastHeading.length > 2 && lastHeading.length < 50) {
			return lastHeading;
		}

		const titleRegex = /<(?:div|span|h4|h5|h6)[^>]*class="[^"]*(?:team-name|title_match|title|name|box-header|identity-title)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|h4|h5|h6)>/gi;
		let tMatch;
		let lastTitle = '';
		while ((tMatch = titleRegex.exec(searchBlock)) !== null) {
			const clean = tMatch[1].replace(/<[^>]+>/g, '').trim();
			if (clean && !clean.toLowerCase().includes('glossary') && !clean.toLowerCase().includes('stats')) {
				lastTitle = clean;
			}
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
			if (cells.some(c => c.toUpperCase().includes('MIN') || c.toUpperCase().includes('PTS') || c.toUpperCase().includes('2M-2A'))) {
				headerCells = cells.map(c => c.toUpperCase().trim());
				headerRowIndex = i;
				break;
			}
		}

		if (headerRowIndex === -1) continue;

		const colMap = {
			player: headerCells.findIndex(h => h === 'PLAYER' || h.includes('PLAYER')),
			min: headerCells.findIndex(h => h === 'MIN' || h === 'M'),
			fg2Combined: headerCells.findIndex(h => h.includes('2M-2A') || h.includes('2M/2A')),
			fg3Combined: headerCells.findIndex(h => h.includes('3M-3A') || h.includes('3M/3A')),
			ftCombined: headerCells.findIndex(h => h.includes('1M-1A') || h.includes('1M/1A') || h.includes('FTM-FTA')),
			fgm: headerCells.findIndex(h => h === 'FGM'),
			fga: headerCells.findIndex(h => h === 'FGA'),
			fg3m: headerCells.findIndex(h => h === '3PM' || h === '3FG'),
			fg3a: headerCells.findIndex(h => h === '3PA'),
			ftm: headerCells.findIndex(h => h === 'FTM'),
			fta: headerCells.findIndex(h => h === 'FTA'),
			oreb: headerCells.findIndex(h => h === 'OR' || h === 'OFF' || h === 'OREB'),
			dreb: headerCells.findIndex(h => h === 'DR' || h === 'DEF' || h === 'DREB'),
			reb: headerCells.findLastIndex(h => h === 'REB' || h === 'TOT' || h === 'TR'),
			ast: headerCells.findLastIndex(h => h === 'AST' || h === 'AS'),
			tov: headerCells.findLastIndex(h => h === 'TO' || h === 'TOV'),
			stl: headerCells.findLastIndex(h => h === 'STL' || h === 'ST'),
			blk: headerCells.findLastIndex(h => h === 'BLK' || h === 'BS'),
			pf: headerCells.findLastIndex(h => h === 'FO' || h === 'PF' || h === 'F'),
			pts: headerCells.findLastIndex(h => h === 'PTS' || h === 'POINTS'),
			plusMinus: headerCells.findIndex(h => h === '+/-' || h.includes('+/-') || h === 'PM')
		};

		// If neither player column nor (min/pts/2M-2A) is mapped, skip
		if (colMap.player === -1 || (colMap.min === -1 && colMap.pts === -1 && colMap.fg2Combined === -1)) continue;

		const parseCombined = (val) => {
			if (!val || typeof val !== 'string' || !val.includes('-')) return [0, 0];
			const parts = val.split('-').map(v => parseInt(v.trim(), 10) || 0);
			return [parts[0] || 0, parts[1] || 0];
		};

		const parsedRows = [];
		let totalsRow = null;

		// Parse player rows (everything after the header row)
		for (let i = headerRowIndex + 1; i < rowsHtml.length; i++) {
			const cells = getCells(rowsHtml[i]);
			if (cells.length < 4) continue;

			const rawName = cells[colMap.player !== -1 ? colMap.player : 0];
			if (!rawName || rawName.toUpperCase() === 'PLAYER' || rawName.includes('Player Name')) continue;

			const isTotals = rawName.toUpperCase().includes('TOTAL') || rawName.toUpperCase().includes('TEAM') || rawName.toUpperCase().includes('TOTALS');

			const valOf = (colIdx) => {
				if (colIdx === -1 || colIdx >= cells.length) return 0;
				return parseInt(cells[colIdx], 10) || 0;
			};

			const rawMin = colMap.min !== -1 ? cells[colMap.min] : '0:00';
			if (!isTotals && (!rawMin || rawMin === '0' || rawMin === '0:00' || rawMin === '00:00' || rawMin === '-')) {
				continue;
			}

			let [fg2m, fg2a] = colMap.fg2Combined !== -1 ? parseCombined(cells[colMap.fg2Combined]) : [0, 0];
			let [fg3m, fg3a] = colMap.fg3Combined !== -1 ? parseCombined(cells[colMap.fg3Combined]) : [0, 0];
			let [ftm, fta] = colMap.ftCombined !== -1 ? parseCombined(cells[colMap.ftCombined]) : [0, 0];

			let fgm = colMap.fgm !== -1 ? valOf(colMap.fgm) : (fg2m + fg3m);
			let fga = colMap.fga !== -1 ? valOf(colMap.fga) : (fg2a + fg3a);
			if (colMap.fg3m !== -1) fg3m = valOf(colMap.fg3m);
			if (colMap.fg3a !== -1) fg3a = valOf(colMap.fg3a);
			if (colMap.ftm !== -1) ftm = valOf(colMap.ftm);
			if (colMap.fta !== -1) fta = valOf(colMap.fta);

			const oreb = valOf(colMap.oreb);
			const dreb = valOf(colMap.dreb);
			const reb = colMap.reb !== -1 ? valOf(colMap.reb) : (oreb + dreb);
			const ast = valOf(colMap.ast);
			const stl = valOf(colMap.stl);
			const blk = valOf(colMap.blk);
			const tov = valOf(colMap.tov);
			const pf = valOf(colMap.pf);
			const pts = colMap.pts !== -1 ? valOf(colMap.pts) : (fg2m * 2 + fg3m * 3 + ftm);
			const plus_minus = colMap.plusMinus !== -1 ? (parseInt(cells[colMap.plusMinus], 10) || 0) : 0;

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
				plus_minus
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
		throw new Error(`[DOM Error] Found fewer than 2 statistics tables for BSN game ${gameId}.`);
	}

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
		homeTable = statsTables[0] || null;
		awayTable = statsTables[1] || statsTables[0] || null;
	}

	const homeTeamName = homeTable ? homeTable.candidateTeamName || 'Home Team' : 'Home Team';
	const awayTeamName = awayTable ? awayTable.candidateTeamName || 'Away Team' : 'Away Team';

	const homeScore = homeTable ? (homeTable.totals ? homeTable.totals.pts : homeTable.players.reduce((sum, p) => sum + p.pts, 0)) : 0;
	const awayScore = awayTable ? (awayTable.totals ? awayTable.totals.pts : awayTable.players.reduce((sum, p) => sum + p.pts, 0)) : 0;

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
		gameDate = `${season}-07-15`;
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

	return {
		gameId,
		season,
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

export default { parseBsnHtml };
