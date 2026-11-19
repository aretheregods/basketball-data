/**
 * @file pbp_support.mjs
 * @description Central registry of leagues that implement the play-by-play (`--type=pbp`) pipeline.
 * The extract/transform/load stages only know how to harvest, shape and persist PBP rows for the
 * leagues listed here; every other league would fetch its whole season and write nothing. The
 * helpers below let the CLI orchestrator and the extract stage reject unsupported combinations
 * up front, before any network request is made.
 */

/**
 * @description Normalized league keys with a fully implemented play-by-play pipeline.
 * `europe` is a container league: every European competition routes through the shared
 * `europe/pbp` transformers, so test keys such as `europe_lkl_test` resolve through the
 * `europe*` prefix check in {@link isPbpSupported}.
 * @type {ReadonlySet<string>}
 */
export const PBP_SUPPORTED_LEAGUES = Object.freeze(new Set(['nba', 'wnba', 'nbl', 'europe', 'bleague']));

/**
 * @description Normalizes a league CLI key down to its registry key. Strips the `_test` harness
 * suffix first (e.g. `bleague_pbp_test`) and then the `_pbp` pipeline segment, so both plain
 * (`bleague`) and test (`bleague_pbp_test`) keys resolve to the same registry entry.
 * @param {string} league - The raw league identifier (e.g. 'cba', 'bleague_pbp_test')
 * @returns {string} The normalized lowercase registry key (e.g. 'cba', 'bleague')
 */
function normalizeLeagueKey(league) {
	let key = String(league || '').toLowerCase().trim();
	if (key.endsWith('_test')) {
		key = key.slice(0, -'_test'.length);
	}
	const pbpIndex = key.indexOf('_pbp');
	if (pbpIndex !== -1) {
		key = key.slice(0, pbpIndex);
	}
	return key;
}

/**
 * @description Checks whether a league implements the play-by-play pipeline.
 * @param {string} league - The league identifier (e.g. 'wnba', 'bleague_pbp_test', 'cba')
 * @returns {boolean} True when `--type=pbp` is supported for the league
 */
export function isPbpSupported(league) {
	const key = normalizeLeagueKey(league);
	return PBP_SUPPORTED_LEAGUES.has(key) || key.startsWith('europe');
}

/**
 * @description Throws when a play-by-play run is requested for a league that has no PBP
 * implementation. No-ops for every other box score type so traditional runs are unaffected.
 * @param {string} league - The league identifier (e.g. 'cba')
 * @param {string} [type='traditional'] - The requested `--type` value (e.g. 'pbp')
 * @returns {boolean} True when the requested combination is supported
 * @throws {Error} When `type` is 'pbp' and the league has no PBP implementation
 */
export function assertPbpSupported(league, type = 'traditional') {
	if (type !== 'pbp') {
		return true;
	}
	if (isPbpSupported(league)) {
		return true;
	}
	throw new Error(
		`❌ Play-by-play (--type=pbp) is not supported for league "${league}". ` +
		`Supported PBP leagues: ${[...PBP_SUPPORTED_LEAGUES].join(', ')}. ` +
		`Run the box score pipeline instead by omitting --type=pbp.`
	);
}
