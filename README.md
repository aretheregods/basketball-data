# Basketball-Data Core

This project implements a modular, high-performance ETL pipeline to scrape, clean, process, load, and sync basketball player and team-level statistics across various international leagues and continents.

## Database & Knex Migrations

The pipeline supports isolated SQLite databases per league or continent (stored in `data/SQL/`, which is ignored in Git).

### Running Migrations Manually via Knex CLI

To manage migrations across our multi-league/multi-database architecture, `knexfile.js` utilizes the `LEAGUE` environment variable to dynamically resolve the database filename path.

For example, to run migrations or check migration status for specific leagues/continents:

```bash
# Migrate WNBA (default)
pnpm exec knex migrate:latest --env development

# Migrate NBA
LEAGUE=nba pnpm exec knex migrate:latest --env development

# Migrate Europe database
LEAGUE=europe pnpm exec knex migrate:latest --env development

# Check migration status for South America
LEAGUE=south_america pnpm exec knex migrate:status --env development
```

### Programmatic Migrations in the ETL

When running the loader stage of the ETL:
```bash
node run.js --step=load
```
The pipeline programmatically invokes `db.migrate.latest()` dynamically on initialization for the active league, ensuring the database schema is fully updated.
