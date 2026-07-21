#!/usr/bin/env node
import { initDatabase } from '../stages/3-load.mjs';

async function main() {
	const league = process.env.LEAGUE || 'WNBA';
	console.log(`🛠️ Running migrations manually for league database: ${league.toUpperCase()}`);
	const db = await initDatabase(league);
	db.destroy();
	console.log(`✨ Migrations completed for ${league.toUpperCase()}!`);
}

main().catch(err => {
	console.error('❌ Migration script failed:', err);
	process.exit(1);
});
