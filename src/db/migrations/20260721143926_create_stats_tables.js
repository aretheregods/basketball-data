/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
	await knex.schema.createTable('player_game_stats', (table) => {
		table.string('game_id');
		table.integer('player_id');
		table.string('player_name');
		table.string('normalized_name');
		table.integer('team_id');
		table.string('team_abbreviation');
		table.string('team_city');
		table.string('start_position');
		table.string('comment');
		table.string('min');
		table.integer('fgm');
		table.integer('fga');
		table.float('fg_pct');
		table.integer('fg3m');
		table.integer('fg3a');
		table.float('fg3_pct');
		table.integer('ftm');
		table.integer('fta');
		table.float('ft_pct');
		table.integer('oreb');
		table.integer('dreb');
		table.integer('reb');
		table.integer('ast');
		table.integer('stl');
		table.integer('blk');
		table.integer('tov');
		table.integer('pf');
		table.integer('pts');
		table.float('plus_minus');
		table.float('ts_pct');
		table.float('efg_pct');
		table.float('game_score');
		table.string('season');
		table.string('league');
		table.integer('synced').defaultTo(0);

		table.primary(['game_id', 'player_id']);
	});

	await knex.schema.createTable('team_game_stats', (table) => {
		table.string('game_id');
		table.integer('team_id');
		table.string('team_name');
		table.string('team_abbreviation');
		table.string('team_city');
		table.string('min');
		table.integer('fgm');
		table.integer('fga');
		table.float('fg_pct');
		table.integer('fg3m');
		table.integer('fg3a');
		table.float('fg3_pct');
		table.integer('ftm');
		table.integer('fta');
		table.float('ft_pct');
		table.integer('oreb');
		table.integer('dreb');
		table.integer('reb');
		table.integer('ast');
		table.integer('stl');
		table.integer('blk');
		table.integer('tov');
		table.integer('pf');
		table.integer('pts');
		table.float('plus_minus');
		table.float('ts_pct');
		table.float('efg_pct');
		table.string('season');
		table.string('league');
		table.integer('synced').defaultTo(0);

		table.primary(['game_id', 'team_id']);
	});
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
	await knex.schema.dropTableIfExists('team_game_stats');
	await knex.schema.dropTableIfExists('player_game_stats');
}
