/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
export default {
	development: {
		client: 'sqlite3',
		connection: {
			filename: './data/SQL/WNBA.sqlite'
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
