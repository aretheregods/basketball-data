/**
 * @typedef {Object} LnbRawPlayer
 * @property {string} raw_name
 * @property {string} raw_minutes
 * @property {number} pts
 * @property {number} oreb
 * @property {number} dreb
 * @property {number} reb
 * @property {number} ast
 * @property {number} stl
 * @property {number} blk
 * @property {number} tov
 * @property {number} pf
 */

/**
 * @description Evaluates the DOM of an LNB Match Center page to extract team names, scores, and individual player box score statistics.
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {string} gameUuid - The game UUID for logging
 * @returns {Promise<Object>} Mapped LNB boxscore object containing homeTeam and awayTeam stats
 */
export async function parseLnbDom(page, gameUuid) {
	const data = await page.evaluate(() => {
		// Try to locate the boxscore tables. There are usually 2 main statistics tables or containers
		const tables = Array.from(document.querySelectorAll('table'));
		if (tables.length < 2) {
			return null;
		}

		/**
		 * Helper to find the team name associated with a table
		 * @param {HTMLTableElement} table
		 * @param {number} index
		 * @returns {string} Team Name
		 */
		const getTeamName = (table, index) => {
			// 1. Try to find in parent containers or headers
			const parent = table.closest('.card, .section, .block, div');
			if (parent) {
				const header = parent.querySelector('.card-header, .title, .team-name, h2, h3, h4');
				if (header && header.innerText && header.innerText.trim()) {
					return header.innerText.trim();
				}
			}

			// 2. Look at previous sibling headings
			let sibling = table.previousElementSibling;
			while (sibling) {
				if (sibling.tagName.match(/^H[1-6]$/) || sibling.classList.contains('title') || sibling.classList.contains('team-name')) {
					if (sibling.innerText && sibling.innerText.trim()) {
						return sibling.innerText.trim();
					}
				}
				sibling = sibling.previousElementSibling;
			}

			// 3. Fallback to general page elements if first/second table
			const generalHeaders = Array.from(document.querySelectorAll('.team-name, .game-header__team-name, h2, h3'));
			if (generalHeaders.length >= 2) {
				const txt = generalHeaders[index]?.innerText?.trim();
				if (txt) return txt;
			}

			return index === 0 ? 'Home Team' : 'Away Team';
		};

		/**
		 * Helper to parse a single team's table
		 * @param {HTMLTableElement} table
		 * @returns {Object} Cleaned team stats and players
		 */
		const parseTable = (table) => {
			const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).map(th => th.innerText.trim().toUpperCase());
			const rows = Array.from(table.querySelectorAll('tbody tr'));

			// Locate column indexes dynamically based on headers
			const colIndex = {
				name: headers.findIndex(h => h.includes('JOUEUR') || h.includes('NOM') || h === 'J' || h === 'PLAYER'),
				min: headers.indexOf('MIN'),
				pts: headers.indexOf('PTS'),
				ro: headers.indexOf('RO') !== -1 ? headers.indexOf('RO') : headers.indexOf('LF'), // fallback or search
				rd: headers.indexOf('RD') !== -1 ? headers.indexOf('RD') : headers.indexOf('DEF'),
				reb: headers.indexOf('REB') !== -1 ? headers.indexOf('REB') : headers.indexOf('RT'),
				pd: headers.indexOf('PD') !== -1 ? headers.indexOf('PD') : headers.indexOf('AST'),
				int: headers.indexOf('INT') !== -1 ? headers.indexOf('INT') : headers.indexOf('STL'),
				ct: headers.indexOf('CT') !== -1 ? headers.indexOf('CT') : headers.indexOf('BLK'),
				bp: headers.indexOf('BP') !== -1 ? headers.indexOf('BP') : headers.indexOf('TOV'),
				fte: headers.indexOf('FTE') !== -1 ? headers.indexOf('FTE') : headers.indexOf('FT')
			};

			// Handle fallbacks if index is not found directly
			if (colIndex.name === -1) colIndex.name = 1; // standard name index is second column
			if (colIndex.min === -1) colIndex.min = 2; // standard min index is third column

			const players = [];

			for (const row of rows) {
				const cells = Array.from(row.querySelectorAll('td'));
				if (cells.length < 5) continue; // skip separator or empty rows

				const nameText = cells[colIndex.name]?.innerText?.trim() || '';
				const minText = cells[colIndex.min]?.innerText?.trim() || '';

				// Skip summary / team total rows
				if (!nameText || nameText.toUpperCase().includes('TOTAL') || nameText.toUpperCase().includes('ÉQUIPE') || nameText.toUpperCase().includes('EQUIPE') || nameText === '-') {
					continue;
				}

				// Skip players who didn't play (e.g. DNP, NE, empty minutes)
				if (!minText || minText === '-' || minText === '0' || minText === '00:00' || minText.toUpperCase().includes('DNP')) {
					continue;
				}

				const getVal = (idx) => {
					if (idx === -1 || !cells[idx]) return 0;
					const txt = cells[idx].innerText.trim();
					return parseInt(txt || '0', 10) || 0;
				};

				// Strip jersey number & starter asterisk (e.g. "9 * Elie Okobo" -> "Elie Okobo")
				const cleanName = nameText.replace(/^\d+\s*\*?\s*/, '').trim();

				players.push({
					playerId: cleanName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
					playerName: cleanName,
					statistics: {
						min: minText,
						pts: getVal(colIndex.pts),
						oreb: getVal(colIndex.ro),
						dreb: getVal(colIndex.rd),
						reb: getVal(colIndex.reb),
						ast: getVal(colIndex.pd),
						stl: getVal(colIndex.int),
						blk: getVal(colIndex.ct),
						tov: getVal(colIndex.bp),
						pf: getVal(colIndex.fte)
					}
				});
			}

			return players;
		};

		// Parse home & away tables
		// In French websites, often Table 1 is Home, Table 2 is Away (or vice versa)
		const homePlayers = parseTable(tables[0]);
		const awayPlayers = parseTable(tables[1]);

		const homeTeamName = getTeamName(tables[0], 0);
		const awayTeamName = getTeamName(tables[1], 1);

		return {
			homePlayers,
			awayPlayers,
			homeTeamName,
			awayTeamName
		};
	});

	// Fail-Fast Assertion
	if (!data || !data.homePlayers || data.homePlayers.length === 0 || !data.awayPlayers || data.awayPlayers.length === 0) {
		throw new Error(`[DOM Error] Extracted 0 player records for LNB game ${gameUuid}. Match Center layout may have changed.`);
	}

	return data;
}
