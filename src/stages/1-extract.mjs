import fs from 'fs/promises';
import path from 'path';
import { validateSchema } from '#utils';

/**
 * @description Runs the extraction stage: fetches the season game log, retrieves game IDs,
 * downloads raw traditional box score payloads, validates them against the JSON schema,
 * and saves them straight to disk without any data transformation.
 *
 * @param {import('../scrapers/wnba/wnba.mjs').WNBAScraper} scraper - The scraper client instance
 * @param {string} league - The lowercase league identifier (e.g., 'wnba')
 * @param {string|number} year - The season year (e.g., '2023')
 * @returns {Promise<string[]>} - Array of scraped game IDs
 * @throws {Error} - If extraction or file operations fail
 */
export async function extractStage(scraper, league, year) {
	console.log(`📥 Starting Stage 1 [EXTRACT] for ${league.toUpperCase()} - ${year}`);

	// 1. Fetch game slugs/keys for the given season
	await scraper.getSeasonGameSlugs(year);

	if (!scraper.gameSlugs || scraper.gameSlugs.length === 0) {
		console.log(`⚠️ No games found for ${league.toUpperCase()} - ${year}`);
		return [];
	}

	// 2. Extract unique game IDs from slugs
	// Slugs are formatted as cleanMatchup-gameId, so we split by '-' and get the last piece
	const gameIds = [...new Set(scraper.gameSlugs.map(slug => slug.split('-').pop()))];
	console.log(`🔍 Found ${gameIds.length} unique game IDs to scrape.`);

	// Ensure output directory exists
	const outputDir = path.resolve('data/raw', league, String(year));
	await fs.mkdir(outputDir, { recursive: true });

	// 3. Download and save raw payload for each game
	for (const gameId of gameIds) {
		const endpoint = '/boxscoretraditionalv2';
		const url = `${endpoint}?EndPeriod=10&EndRange=28800&GameID=${gameId}&RangeType=0&StartPeriod=1&StartRange=0`;

		try {
			console.log(`🛰️ Fetching raw boxscore for Game ID: ${gameId}...`);
			const rawData = await scraper.request(url, {}, 3, 5000);

			// Validate response against schema
			validateSchema(`${league}/boxscore.json`, rawData);

			const filePath = path.join(outputDir, `${gameId}.json`);
			await fs.writeFile(filePath, JSON.stringify(rawData, null, 2), 'utf8');
			console.log(`💾 Saved raw data to ${filePath}`);
		} catch (error) {
			console.error(`❌ Failed to extract/save box score for Game ID ${gameId}:`, error);
			throw error;
		}
	}

	console.log(`✅ Stage 1 [EXTRACT] complete. Processed ${gameIds.length} games.\n`);
	return gameIds;
}
