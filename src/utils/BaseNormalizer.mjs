/**
 * @description BaseNormalizer utility class for cleaning strings, normalizing names, and calculating advanced basketball statistics.
 */
export class BaseNormalizer {
	/**
	 * @description Cleans a string by trimming leading/trailing whitespace and collapsing multiple spaces.
	 * @param {any} str - The value to clean
	 * @returns {string} The cleaned string
	 */
	static cleanString(str) {
		if (typeof str !== 'string') {
			return '';
		}
		return str.trim().replace(/\s+/g, ' ');
	}

	/**
	 * @description Cleans a string by trimming leading/trailing whitespace and collapsing multiple spaces.
	 * @param {any} str - The value to clean
	 * @returns {string} The cleaned string
	 */
	cleanString(str) {
		return BaseNormalizer.cleanString(str);
	}

	/**
	 * @description Normalizes a person's name by removing accents, diacritics, and formatting.
	 * @param {any} name - The name to normalize
	 * @returns {string} The normalized name without accents
	 */
	static normalizeName(name) {
		if (typeof name !== 'string') {
			return '';
		}
		const cleaned = this.cleanString(name);
		return cleaned
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '');
	}

	/**
	 * @description Normalizes a person's name by removing accents, diacritics, and formatting.
	 * @param {any} name - The name to normalize
	 * @returns {string} The normalized name without accents
	 */
	normalizeName(name) {
		return BaseNormalizer.normalizeName(name);
	}

	/**
	 * @description Calculates True Shooting Percentage (TS%).
	 * Formula: PTS / (2 * (FGA + 0.44 * FTA))
	 * @param {number} pts - Points scored
	 * @param {number} fga - Field goal attempts
	 * @param {number} fta - Free throw attempts
	 * @returns {number} The TS% as a decimal, rounded to 4 decimal places
	 */
	static calculateTSPct(pts, fga, fta) {
		const denominator = 2 * (fga + 0.44 * fta);
		if (denominator === 0) {
			return 0.0;
		}
		return parseFloat((pts / denominator).toFixed(4));
	}

	/**
	 * @description Calculates True Shooting Percentage (TS%).
	 * @param {number} pts - Points scored
	 * @param {number} fga - Field goal attempts
	 * @param {number} fta - Free throw attempts
	 * @returns {number} The TS% as a decimal, rounded to 4 decimal places
	 */
	calculateTSPct(pts, fga, fta) {
		return BaseNormalizer.calculateTSPct(pts, fga, fta);
	}

	/**
	 * @description Calculates Effective Field Goal Percentage (eFG%).
	 * Formula: (FGM + 0.5 * FG3M) / FGA
	 * @param {number} fgm - Field goals made
	 * @param {number} fg3m - Three-point field goals made
	 * @param {number} fga - Field goal attempts
	 * @returns {number} The eFG% as a decimal, rounded to 4 decimal places
	 */
	static calculateEFGPct(fgm, fg3m, fga) {
		if (fga === 0) {
			return 0.0;
		}
		return parseFloat(((fgm + 0.5 * fg3m) / fga).toFixed(4));
	}

	/**
	 * @description Calculates Effective Field Goal Percentage (eFG%).
	 * @param {number} fgm - Field goals made
	 * @param {number} fg3m - Three-point field goals made
	 * @param {number} fga - Field goal attempts
	 * @returns {number} The eFG% as a decimal, rounded to 4 decimal places
	 */
	calculateEFGPct(fgm, fg3m, fga) {
		return BaseNormalizer.calculateEFGPct(fgm, fg3m, fga);
	}

	/**
	 * @description Calculates Game Score (GmSC).
	 * Formula: PTS + 0.4 * FGM - 0.7 * FGA - 0.4 * (FTA - FTM) + 0.7 * OREB + 0.3 * DREB + STL + 0.7 * AST + 0.7 * BLK - 0.4 * PF - TO
	 * @param {number} pts - Points
	 * @param {number} fgm - Field goals made
	 * @param {number} fga - Field goal attempts
	 * @param {number} fta - Free throw attempts
	 * @param {number} ftm - Free throws made
	 * @param {number} oreb - Offensive rebounds
	 * @param {number} dreb - Defensive rebounds
	 * @param {number} stl - Steals
	 * @param {number} ast - Assists
	 * @param {number} blk - Blocks
	 * @param {number} pf - Personal fouls
	 * @param {number} to - Turnovers
	 * @returns {number} The Game Score, rounded to 1 decimal place
	 */
	static calculateGameScore(pts, fgm, fga, fta, ftm, oreb, dreb, stl, ast, blk, pf, to) {
		const score = pts +
			0.4 * fgm -
			0.7 * fga -
			0.4 * (fta - ftm) +
			0.7 * oreb +
			0.3 * dreb +
			stl +
			0.7 * ast +
			0.7 * blk -
			0.4 * pf -
			to;
		return parseFloat(score.toFixed(1));
	}

	/**
	 * @description Calculates Game Score (GmSC).
	 * @param {number} pts - Points
	 * @param {number} fgm - Field goals made
	 * @param {number} fga - Field goal attempts
	 * @param {number} fta - Free throw attempts
	 * @param {number} ftm - Free throws made
	 * @param {number} oreb - Offensive rebounds
	 * @param {number} dreb - Defensive rebounds
	 * @param {number} stl - Steals
	 * @param {number} ast - Assists
	 * @param {number} blk - Blocks
	 * @param {number} pf - Personal fouls
	 * @param {number} to - Turnovers
	 * @returns {number} The Game Score, rounded to 1 decimal place
	 */
	calculateGameScore(pts, fgm, fga, fta, ftm, oreb, dreb, stl, ast, blk, pf, to) {
		return BaseNormalizer.calculateGameScore(pts, fgm, fga, fta, ftm, oreb, dreb, stl, ast, blk, pf, to);
	}
}
