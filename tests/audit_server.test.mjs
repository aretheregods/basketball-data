import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../src/audit/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('Audit Server API - /api/unplayed/delete Integration Tests', () => {
	let server;
	const PORT = 3005;
	const league = 'audit_server_test';
	const season = '2026';
	const rawDir = path.resolve(PROJECT_ROOT, 'data/raw', league, season);

	test.before(async () => {
		// Clean up and create mock raw unplayed files
		await fs.mkdir(rawDir, { recursive: true });

		await fs.writeFile(
			path.join(rawDir, 'game_1.json'),
			JSON.stringify({
				gameId: 'game_1',
				homeTeam: { teamName: 'Unplayed' },
				awayTeam: { teamName: 'Unplayed' }
			}, null, 2),
			'utf8'
		);

		await fs.writeFile(
			path.join(rawDir, 'game_2.json'),
			JSON.stringify({
				gameId: 'game_2',
				homeTeam: { teamName: 'Unplayed' },
				awayTeam: { teamName: 'Unplayed' }
			}, null, 2),
			'utf8'
		);

		// Also create a playable game to ensure we don't delete non-unplayed games
		await fs.writeFile(
			path.join(rawDir, 'game_3.json'),
			JSON.stringify({
				gameId: 'game_3',
				homeTeam: { teamName: 'Vaqueros' },
				awayTeam: { teamName: 'Cangrejeros' }
			}, null, 2),
			'utf8'
		);

		// Start server
		server = startServer(PORT);
	});

	test.after(async () => {
		// Close server
		if (server) {
			await new Promise((resolve) => server.close(resolve));
		}
		// Clean up files
		await fs.rm(path.resolve(PROJECT_ROOT, 'data/raw', league), { recursive: true, force: true });
		// Also clean up any transformed files generated during rerun
		await fs.rm(path.resolve(PROJECT_ROOT, 'data/transformed', league), { recursive: true, force: true });
	});

	test('should delete an individual unplayed game and skip non-matching/non-unplayed games', async () => {
		const res = await fetch(`http://localhost:${PORT}/api/unplayed/delete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ league, season, gameId: 'game_1' })
		});

		const data = await res.json();
		assert.equal(res.status, 200);
		assert.equal(data.success, true);
		assert.equal(data.deletedCount, 1);
		assert.deepEqual(data.deletedGames, ['game_1']);

		// Verify game_1.json is deleted
		const exists1 = await fs.access(path.join(rawDir, 'game_1.json')).then(() => true).catch(() => false);
		assert.equal(exists1, false, 'game_1.json should be deleted');

		// Verify game_2.json still exists (since it is unplayed but wasn't specified by gameId)
		const exists2 = await fs.access(path.join(rawDir, 'game_2.json')).then(() => true).catch(() => false);
		assert.equal(exists2, true, 'game_2.json should still exist');

		// Verify game_3.json still exists
		const exists3 = await fs.access(path.join(rawDir, 'game_3.json')).then(() => true).catch(() => false);
		assert.equal(exists3, true, 'game_3.json should still exist');
	});

	test('should delete all remaining unplayed games for the season and keep non-unplayed games', async () => {
		const res = await fetch(`http://localhost:${PORT}/api/unplayed/delete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ league, season })
		});

		const data = await res.json();
		assert.equal(res.status, 200);
		assert.equal(data.success, true);
		assert.equal(data.deletedCount, 1); // Only game_2.json was left as unplayed
		assert.deepEqual(data.deletedGames, ['game_2']);

		// Verify game_2.json is deleted
		const exists2 = await fs.access(path.join(rawDir, 'game_2.json')).then(() => true).catch(() => false);
		assert.equal(exists2, false, 'game_2.json should be deleted');

		// Verify game_3.json is NOT deleted because it is not an unplayed game
		const exists3 = await fs.access(path.join(rawDir, 'game_3.json')).then(() => true).catch(() => false);
		assert.equal(exists3, true, 'game_3.json should not be deleted');
	});

	test('should filter out test databases containing _test in /api/audit', async () => {
		const dbDir = path.resolve(PROJECT_ROOT, 'data/SQL');
		await fs.mkdir(dbDir, { recursive: true });

		// Create a test database file
		const testDbPath = path.join(dbDir, 'DUMMY_TEST.sqlite');
		await fs.writeFile(testDbPath, '', 'utf8');

		try {
			const res = await fetch(`http://localhost:${PORT}/api/audit`);
			const data = await res.json();
			assert.equal(res.status, 200);
			assert.ok(data.databases);
			// Verify that dummy_test is NOT in the audited databases list
			assert.equal(data.databases['dummy_test'], undefined, 'dummy_test database should be filtered out');
		} finally {
			// Clean up dummy test database
			await fs.rm(testDbPath, { force: true });
		}
	});
});
