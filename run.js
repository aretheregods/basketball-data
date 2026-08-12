#!/usr/bin/env node

/**
 * @file run.js
 * @description Lean CLI entry point & global orchestrator for Basketball ETL Pipeline.
 * Parses dynamic CLI options and coordinates execution across pipeline stages.
 */

import { WNBAScraper } from './src/scrapers/wnba/wnba.mjs';
import { NBAScraper } from './src/scrapers/nba/nba.mjs';
import { EuropeScraper } from './src/scrapers/europe/europe.mjs';
import { LnbpScraper } from './src/scrapers/mexico/LnbpScraper.mjs';
import { CeblScraper } from './src/scrapers/canada/CeblScraper.mjs';
import { BsnScraper } from './src/scrapers/puertorico/BsnScraper.mjs';
import { SouthAmericaScraper } from './src/scrapers/southamerica/SouthAmericaScraper.mjs';
import { NblScraper } from './src/scrapers/nbl/NblScraper.mjs';
import { extractStage } from './src/stages/1-extract.mjs';
import { transformStage } from './src/stages/2-transform.mjs';
import { loadStage } from './src/stages/3-load.mjs';
import { syncStage } from './src/stages/4-sync.mjs';

// Audit Engine and Web Server imports
import { AuditEngine } from './src/audit/AuditEngine.mjs';
import { startServer } from './src/audit/server.mjs';
import fs from 'fs';
import path from 'path';

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
	nba: (options) => new NBAScraper(options),
	europe: (options) => new EuropeScraper(options),
	mexico: (options) => new LnbpScraper(options),
	canada: (options) => new CeblScraper(options),
	puertorico: (options) => new BsnScraper(options),
	southamerica: (options) => new SouthAmericaScraper(options),
	nbl: (options) => new NblScraper(options),
};

/**
 * @description Runs a beautiful command-line terminal audit of all local sqlite databases.
 * @returns {void}
 */
function runCliAudit() {
	console.log(`\n==================================================================================`);
	console.log(`                     🏀 LIKELYHIGH ETL LOCAL HEALTH REPORT`);
	console.log(`==================================================================================`);
	console.log(String().padEnd(16) + ' | ' + 'Season'.padEnd(6) + ' | ' + 'Games'.padStart(6) + ' | ' + 'Mismatches'.padStart(10) + ' | ' + 'Missing'.padStart(8) + ' | ' + 'Low-Min'.padStart(8) + ' | ' + 'Pending'.padStart(8));
	console.log(`----------------------------------------------------------------------------------`);

	const dbDir = path.resolve('data/SQL');
	let totalGamesCount = 0;
	let totalMismatchCount = 0;
	let totalMissingCount = 0;
	let totalLowMinCount = 0;
	let totalPendingCount = 0;

	if (fs.existsSync(dbDir)) {
		const files = fs.readdirSync(dbDir).filter(f => f.endsWith('.sqlite'));
		for (const file of files) {
			const dbPath = path.join(dbDir, file);
			const league = file.replace('.sqlite', '');
			try {
				const engine = new AuditEngine(dbPath);
				const report = engine.runFullAudit();

				for (const [season, sData] of Object.entries(report.seasons)) {
					const mismatches = sData.scoreMismatches.length;
					const missing = sData.missingBoxscores.length;
					const lowMin = sData.lowMinAnomalies.length;
					const pending = sData.syncStatus.unsyncedGames;

					console.log(
						league.toUpperCase().padEnd(16) + ' | ' +
						season.padEnd(6) + ' | ' +
						String(sData.gamesCount).padStart(6) + ' | ' +
						String(mismatches).padStart(10) + ' | ' +
						String(missing).padStart(8) + ' | ' +
						String(lowMin).padStart(8) + ' | ' +
						String(pending).padStart(8)
					);

					totalGamesCount += sData.gamesCount;
					totalMismatchCount += mismatches;
					totalMissingCount += missing;
					totalLowMinCount += lowMin;
					totalPendingCount += pending;
				}
			} catch (err) {
				console.log(`${league.toUpperCase().padEnd(16)} | ❌ Audit execution failed: ${err.message}`);
			}
		}
	} else {
		console.log(`⚠️  No databases folder found at "${dbDir}". Try running a full ETL run first.`);
	}

	console.log(`----------------------------------------------------------------------------------`);
	console.log(
		'TOTALS'.padEnd(16) + ' | ' +
		''.padEnd(6) + ' | ' +
		String(totalGamesCount).padStart(6) + ' | ' +
		String(totalMismatchCount).padStart(10) + ' | ' +
		String(totalMissingCount).padStart(8) + ' | ' +
		String(totalLowMinCount).padStart(8) + ' | ' +
		String(totalPendingCount).padStart(8)
	);
	console.log(`==================================================================================`);

	// Log unmapped entities summary
	const unmappedPath = path.resolve('data/unmapped_entities.json');
	if (fs.existsSync(unmappedPath)) {
		try {
			const content = JSON.parse(fs.readFileSync(unmappedPath, 'utf8'));
			const teamsCount = Array.isArray(content.teams) ? content.teams.length : 0;
			const playersCount = Array.isArray(content.players) ? content.players.length : 0;
			console.log(`⚠️  Unmapped Entities Logged: ${teamsCount} Teams, ${playersCount} Players.`);
		} catch (e) {
			// Ignored
		}
	} else {
		console.log(`🟢 No unmapped entities logged.`);
	}
	console.log(`==================================================================================\n`);
}

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
	const competitions = flags.competitions || 'euroleague';

	// Handle direct --step=audit interceptor
	if (activeSteps.includes('audit')) {
		runCliAudit();
		// Start the server to view web dashboard
		startServer(3000);
		// Keep process alive when running ONLY audit
		if (activeSteps.length === 1) {
			return new Promise(() => {}); // never resolves, keeps server running
		}
	}

	console.log(`🚀 LikelyHigh Pipeline Initialized.`);
	console.log(`Steps: ${activeSteps.join(' -> ')} | Leagues: ${targetLeagues.join(', ')} | Years: ${targetYears.join(', ')}\n`);

	for (const league of targetLeagues) {
		const lowerLeague = league.toLowerCase();
		if (!LEAGUE_SCRAPERS[lowerLeague]) {
			console.error(`❌ League "${league}" not registered in scraper configuration.`);
			continue;
		}

		const scraper = LEAGUE_SCRAPERS[lowerLeague]({ boxscoreType, competitions });

		// Support targeting specific game IDs: --game=xxx or --games=xxx
		if (flags.game || flags.games) {
			const filterVal = flags.game || flags.games;
			console.log(`🎯 Filtering pipeline execution to games containing: "${filterVal}"`);
			const originalGetSlugs = scraper.getSeasonGameSlugs;
			scraper.getSeasonGameSlugs = async function(year) {
				await originalGetSlugs.call(this, year);
				if (this.gameSlugs) {
					const before = this.gameSlugs.length;
					this.gameSlugs = this.gameSlugs.filter(slug =>
						slug.includes(filterVal) || slug.split('-').pop() === filterVal
					);
					console.log(`🎯 Slugs filtered from ${before} down to ${this.gameSlugs.length}`);
				}
				return this;
			};
		}

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
	}
	console.log('\n✅ Script pipeline task sequence complete.');
}

main().catch(err => {
	console.error('\n❌ FATAL SYSTEM FAILURE:', err);
	process.exit(1);
});
