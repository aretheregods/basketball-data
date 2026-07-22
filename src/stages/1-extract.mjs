import fs from 'fs/promises';
import path from 'path';
import { validateSchema } from '#utils';

/**
 * @description Runs the extraction stage: fetches the season game log, retrieves game IDs,
 * downloads raw traditional box score payloads, validates them against the JSON schema,
 * and saves them straight to disk without any data transformation.
 *
 * @param {Object} scraper - The scraper client instance
 * @param {function(string): string} scraper.getGameEndpoint - Gets the endpoint for a given game ID
 * @param {function(string): string} scraper.getGameUrl - Gets the complete URL for a given game ID
 * @param {function(string, Object=, number=, number=): Promise<any>} scraper.request - Makes HTTP request
 * @param {function(string|number): Promise<any>} scraper.getSeasonGameSlugs - Fetches game slugs for a season
 * @param {string[]} scraper.gameSlugs - Array of fetched game slugs
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
		const filePath = path.join(outputDir, `${gameId}.json`);

		// Cache check: skip if the file already exists and is non-empty
		try {
			const stats = await fs.stat(filePath);
			if (stats.size > 0) {
				console.log(`⏭️ Game ID: ${gameId} already exists in raw cache. Skipping...`);
				continue;
			}
		} catch (e) {
			// File does not exist, proceed with extraction
		}

		const endpoint = scraper.getGameEndpoint(gameId);
		const url = scraper.getGameUrl(gameId);

		try {
			console.log(`🛰️ Fetching raw boxscore for Game ID: ${gameId}...`);
			const rawData = await scraper.request(url, {}, 3, 5000);

			// Validate response against schema
			validateSchema(`${league}/boxscore.json`, rawData);

			await fs.writeFile(filePath, JSON.stringify(rawData, null, 2), 'utf8');
			console.log(`💾 Saved raw data to ${filePath}`);

			// Add a short randomized delay to prevent rate-limiting (skipped in testing)
			if (process.env.NODE_ENV !== 'test') {
				const delay = 1000 + Math.floor(Math.random() * 1000);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		} catch (error) {
			console.error(`❌ Failed to extract/save box score for Game ID ${gameId}:`, error);
			throw error;
		}
	}

	console.log(`✅ Stage 1 [EXTRACT] complete. Processed ${gameIds.length} games.\n`);
	return gameIds;
}
