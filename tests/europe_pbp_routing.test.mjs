import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EUROPE_LEAGUE_REGISTRY } from '../src/db/europe_league_registry.mjs';
import { loadStage } from '../src/stages/3-load.mjs';

test('routes PBP rows to every registered European league database', async () => {
	const databaseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'europe-pbp-routing-'));
	try {
		const events = Object.entries(EUROPE_LEAGUE_REGISTRY).map(([leagueId, config], index) => ({
			event_id: `routing_event_${index}`,
			game_id: `routing_game_${index}`,
			competition_id: config.competitions[0],
			period: 1,
			clock: '10:00',
			seconds_remaining: 600,
			event_type: 'test',
			home_score: 0,
			away_score: 0,
			description: leagueId
		}));

		await loadStage('europe', '2026', { events, stints: [] }, {
			type: 'pbp',
			competitions: 'all',
			databaseDirectory
		});

		for (const [leagueId, config] of Object.entries(EUROPE_LEAGUE_REGISTRY)) {
			const dbPath = path.join(databaseDirectory, `${path.basename(config.dbFile, '.sqlite').toUpperCase()}.sqlite`);
			const db = new DatabaseSync(dbPath);
			try {
				const row = db.prepare('SELECT COUNT(*) AS count FROM game_play_by_play').get();
				assert.equal(row.count, 1, `expected one PBP event in ${leagueId} database`);
			} finally {
				db.close();
			}
		}
	} finally {
		await fs.rm(databaseDirectory, { recursive: true, force: true });
	}
});
