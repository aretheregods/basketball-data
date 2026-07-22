import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { EuropeanEntityResolver } from '#utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

test.describe('EuropeanEntityResolver', () => {
	const testUnmappedPath = path.resolve(PROJECT_ROOT, 'data/unmapped_entities.json');

	test.beforeEach(async () => {
		// Clean unmapped entities file before each test
		await fs.rm(testUnmappedPath, { force: true });
	});

	test.afterEach(async () => {
		// Clean up after test
		await fs.rm(testUnmappedPath, { force: true });
	});

	test('should successfully resolve configured team aliases', () => {
		const resolver = new EuropeanEntityResolver();

		assert.equal(resolver.resolveTeam('PANATHINAIKOS AKTOR ATHENS'), 'panathinaikos');
		assert.equal(resolver.resolveTeam('Real Madrid Baloncesto'), 'real-madrid');
		assert.equal(resolver.resolveTeam('FC BARCELONA'), 'fc-barcelona');
	});

	test('should fall back to slugifying team name and stripping sponsors', () => {
		const resolver = new EuropeanEntityResolver();

		// "Anadolu Efes Istanbul" -> "anadolu-efes-istanbul"
		assert.equal(resolver.resolveTeam('Anadolu Efes Istanbul'), 'anadolu-efes-istanbul');

		// CSKA Moscow CSKA -> csk-moscow
		assert.equal(resolver.resolveTeam('CSKA Moscow'), 'moscow');
	});

	test('should successfully resolve player names to slugs', () => {
		const resolver = new EuropeanEntityResolver();

		assert.equal(resolver.resolvePlayer('Nikola Mirotić'), 'nikola-mirotic');
		assert.equal(resolver.resolvePlayer('Kostas Sloukas'), 'kostas-sloukas');
		assert.equal(resolver.resolvePlayer('Cedi Osman'), 'cedi-osman');
	});

	test('should write to unmapped_entities.json and throw on unresolved name', async () => {
		const resolver = new EuropeanEntityResolver();

		// Since blank string cannot be slugified, it should throw
		assert.throws(() => {
			resolver.resolveTeam('   ');
		}, /Unresolved team name/);

		const exists = await fs.access(testUnmappedPath).then(() => true).catch(() => false);
		assert.equal(exists, true);

		const unmappedContent = JSON.parse(await fs.readFile(testUnmappedPath, 'utf8'));
		assert.ok(unmappedContent.teams.includes('   '));
	});
});
