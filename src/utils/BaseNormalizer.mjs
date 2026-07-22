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
	 * @description Transliterates Cyrillic and Greek characters to their Latin/ASCII equivalents.
	 * @param {string} text - The input text to transliterate
	 * @returns {string} The transliterated text
	 */
	static transliterate(text) {
		if (typeof text !== 'string') {
			return '';
		}
		const translitMap = {
			// Greek uppercase
			'Α': 'A', 'Β': 'V', 'Γ': 'G', 'Δ': 'D', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'I', 'Θ': 'Th',
			'Ι': 'I', 'Κ': 'K', 'Λ': 'L', 'Μ': 'M', 'Ν': 'N', 'Ξ': 'X', 'Ο': 'O', 'Π': 'P',
			'Ρ': 'R', 'Σ': 'S', 'Τ': 'T', 'Υ': 'Y', 'Φ': 'F', 'Χ': 'Ch', 'Ψ': 'Ps', 'Ω': 'O',
			// Greek lowercase
			'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th',
			'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p',
			'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
			// Greek accented uppercase
			'Ά': 'A', 'Έ': 'E', 'Ή': 'I', 'Ί': 'I', 'Ό': 'O', 'Ύ': 'Y', 'Ώ': 'O', 'Ϊ': 'I', 'Ϋ': 'Y',
			// Greek accented lowercase
			'ά': 'a', 'έ': 'e', 'ή': 'i', 'ί': 'i', 'ό': 'o', 'ύ': 'y', 'ώ': 'o', 'ϊ': 'i', 'ϋ': 'y', 'ΐ': 'i', 'ΰ': 'y',

			// Cyrillic uppercase
			'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo', 'Ж': 'Zh', 'З': 'Z',
			'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R',
			'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh',
			'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
			// Cyrillic lowercase
			'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z',
			'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
			'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
			'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',

			// Other Slavic Cyrillic (Serbian, Macedonian, Ukrainian, etc.)
			'Ђ': 'Dj', 'Ѓ': 'G', 'Є': 'Ye', 'Ѕ': 'Dz', 'І': 'I', 'Ї': 'Yi', 'Ј': 'J', 'Љ': 'Lj', 'Њ': 'Nj', 'Ћ': 'C', 'Ќ': 'K', 'Ў': 'W', 'Џ': 'Dz',
			'ђ': 'dj', 'ѓ': 'g', 'є': 'ye', 'ѕ': 'dz', 'і': 'i', 'ї': 'yi', 'ј': 'j', 'љ': 'lj', 'њ': 'nj', 'ћ': 'c', 'ќ': 'k', 'ў': 'w', 'џ': 'dz',
			'Ґ': 'G', 'ґ': 'g'
		};

		return text.split('').map(char => translitMap[char] ?? char).join('');
	}

	/**
	 * @description Normalizes a person's name by transliterating, removing accents, diacritics, and formatting.
	 * @param {any} name - The name to normalize
	 * @returns {string} The normalized name without accents
	 */
	static normalizeName(name) {
		if (typeof name !== 'string') {
			return '';
		}
		const transliterated = this.transliterate(name);
		const cleaned = this.cleanString(transliterated);
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

	/**
	 * @description Parses ISO-8601 duration strings or traditional MM:SS strings into a floating-point number representing minutes.
	 * @param {any} minStr - The minutes value to parse
	 * @returns {number} The parsed minutes as a float rounded to 1 decimal place
	 */
	static parseMinutesToFloat(minStr) {
		if (minStr === null || minStr === undefined || minStr === '') {
			return 0.0;
		}
		if (typeof minStr === 'number') {
			return Math.round(minStr * 10) / 10;
		}
		const cleaned = String(minStr).trim();
		if (cleaned === '') {
			return 0.0;
		}

		// Handle ISO-8601 duration, e.g. "PT36M12.00S", "PT10M", "PT1H20M5S"
		if (cleaned.startsWith('PT')) {
			const hoursMatch = cleaned.match(/(\d+)H/);
			const minutesMatch = cleaned.match(/(\d+)M/);
			const secondsMatch = cleaned.match(/(\d+(?:\.\d+)?)S/);

			const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
			const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
			const seconds = secondsMatch ? parseFloat(secondsMatch[1]) : 0.0;

			const totalMinutes = (hours * 60) + minutes + (seconds / 60);
			return Math.round(totalMinutes * 10) / 10;
		}

		// Handle traditional MM:SS, e.g. "36:12" or "05:03"
		if (cleaned.includes(':')) {
			const parts = cleaned.split(':');
			const minutes = parseInt(parts[0], 10) || 0;
			const seconds = parseFloat(parts[1]) || 0;
			const totalMinutes = minutes + (seconds / 60);
			return Math.round(totalMinutes * 10) / 10;
		}

		// Handle simple number string, e.g. "36"
		const parsed = parseFloat(cleaned);
		if (isNaN(parsed)) {
			return 0.0;
		}
		return Math.round(parsed * 10) / 10;
	}

	/**
	 * @description Parses ISO-8601 duration strings or traditional MM:SS strings into a floating-point number representing minutes.
	 * @param {any} minStr - The minutes value to parse
	 * @returns {number} The parsed minutes as a float rounded to 1 decimal place
	 */
	parseMinutesToFloat(minStr) {
		return BaseNormalizer.parseMinutesToFloat(minStr);
	}
}
