/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
const league = (process.env.LEAGUE || 'WNBA').toUpperCase();

export default {
	development: {
		client: 'sqlite3',
		connection: {
			filename: `./data/SQL/${league}.sqlite`
		},
		useNullAsDefault: true,
		migrations: {
			directory: './src/db/migrations',
			tableName: 'knex_migrations'
		}
	},
	test: {
		client: 'sqlite3',
		connection: {
			filename: ':memory:'
		},
		useNullAsDefault: true,
		migrations: {
			directory: './src/db/migrations',
			tableName: 'knex_migrations'
		}
	}
};
