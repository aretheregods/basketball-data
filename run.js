#!/usr/bin/env node

/**
 * @file run.js
 * @description Lean CLI entry point & global orchestrator for Basketball ETL Pipeline.
 * Parses dynamic CLI options and coordinates execution across pipeline stages.
 */

import { WNBAScraper } from './src/scrapers/wnba/wnba.mjs';
import { extractStage } from './src/stages/1-extract.mjs';
import { transformStage } from './src/stages/2-transform.mjs';
import { loadStage } from './src/stages/3-load.mjs';
import { syncStage } from './src/stages/4-sync.mjs';

/**
 * @description Parses process.argv arguments into an options object.
 * Supports flags formatted as --key=value or standalone flags.
 * @returns {Record<string, string>}
 */
function parseArgs() {
	/** @type {Record<string, string>} */
	const args = {};
	process.argv.slice(2).forEach(arg => {
		if (arg.startsWith('--')) {
			const cleanArg = arg.replace('--', '');
			if (cleanArg.includes('=')) {
				const [key, value] = cleanArg.split('=');
				args[key] = value;
			} else {
				args[cleanArg] = 'true';
			}
		}
	});
	return args;
}

// Master registry defining the scrapers for each league
const LEAGUE_SCRAPERS = {
	wnba: (options) => new WNBAScraper(options),
	// nba: (options) => new NBAScraper(options),
};

/**
 * @description Main pipeline orchestrator function.
 * @returns {Promise<void>}
 */
async function main() {
	const flags = parseArgs();

	// Dynamic fallbacks
	const targetLeagues = flags.league ? flags.league.split(',') : ['wnba'];
	const targetYears = flags.years ? flags.years.split(',') : [new Date().getFullYear().toString()];

	// Allow targeting specific steps: --step=extract or run all by default
	const activeSteps = flags.step ? flags.step.split(',') : ['extract', 'transform', 'load', 'sync'];
	const databaseName = flags.database || 'likelyhigh_db';
	const dryRun = flags.dryRun === 'true' || flags['dry-run'] === 'true';
	const boxscoreType = flags['boxscore-type'] || flags.type || 'traditional';

	console.log(`🚀 LikelyHigh Pipeline Initialized.`);
	console.log(`Steps: ${activeSteps.join(' -> ')} | Leagues: ${targetLeagues.join(', ')} | Years: ${targetYears.join(', ')}\n`);

	for (const league of targetLeagues) {
		const lowerLeague = league.toLowerCase();
		if (!LEAGUE_SCRAPERS[lowerLeague]) {
			console.error(`❌ League "${league}" not registered in scraper configuration.`);
			continue;
		}

		const scraper = LEAGUE_SCRAPERS[lowerLeague]({ boxscoreType });

		try {
			for (const year of targetYears) {
				console.log(`\n=== Processing [ ${lowerLeague.toUpperCase()} - ${year} ] ===`);

				// ------------------------------------------------------------
				// STAGE 1: EXTRACT (Network Request -> Raw Local Disk JSON)
				// ------------------------------------------------------------
				if (activeSteps.includes('extract')) {
					try {
						await extractStage(scraper, lowerLeague, year);
					} catch (err) {
						console.error(`❌ Stage 1 [EXTRACT] failed for ${lowerLeague.toUpperCase()} - ${year}:`, err.message);
						if (activeSteps.length === 1) throw err; // rethrow if executing only this step
					}
				}

				// ------------------------------------------------------------
				// STAGE 2: TRANSFORM (Read Raw JSON -> Clean/Normalize in Memory)
				// ------------------------------------------------------------
				let cleanedGamesArray = { players: [], teams: [] };
				if (activeSteps.includes('transform')) {
					try {
						cleanedGamesArray = await transformStage(lowerLeague, year);
					} catch (err) {
						console.error(`❌ Stage 2 [TRANSFORM] failed for ${lowerLeague.toUpperCase()} - ${year}:`, err.message);
						if (activeSteps.length === 1) throw err;
					}
				}

				// ------------------------------------------------------------
				// STAGE 3: LOAD (Clean Array -> Local SQLite Database Staging)
				// ------------------------------------------------------------
				if (activeSteps.includes('load')) {
					try {
						await loadStage(lowerLeague, year, cleanedGamesArray);
					} catch (err) {
						console.error(`❌ Stage 3 [LOAD] failed for ${lowerLeague.toUpperCase()} - ${year}:`, err.message);
						if (activeSteps.length === 1) throw err;
					}
				}

				// ------------------------------------------------------------
				// STAGE 4: SYNC (Local SQLite Modifications -> Production D1 Edge)
				// ------------------------------------------------------------
				if (activeSteps.includes('sync')) {
					try {
						await syncStage(lowerLeague, year, { databaseName, dryRun });
					} catch (err) {
						console.error(`❌ Stage 4 [SYNC] failed for ${lowerLeague.toUpperCase()} - ${year}:`, err.message);
						if (activeSteps.length === 1) throw err;
					}
				}
			}
		} finally {
			if (typeof scraper.close === 'function') {
				await scraper.close();
			}
		}
	}
	console.log('\n✅ Script pipeline task sequence complete.');
}

main().catch(err => {
	console.error('\n❌ FATAL SYSTEM FAILURE:', err);
	process.exit(1);
});
