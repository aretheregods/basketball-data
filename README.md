# Basketball-Data Core

This project implements a modular, high-performance ETL pipeline to scrape, clean, process, load, and sync basketball player and team-level statistics across various international leagues and continents.

## Database & Migrations

To avoid the native package compilation difficulties and GLIBC version mismatches of heavy query builders, this project uses a custom, zero-dependency migrations engine powered by Node.js's built-in `node:sqlite` (`DatabaseSync`) module.

SQLite database files are stored per league or continent (stored in `data/SQL/`, which is ignored in Git).

### Running Migrations Manually via CLI

To run or check migrations manually across our multi-league/multi-database architecture, use the custom migration script and set the `LEAGUE` environment variable:

```bash
# Migrate WNBA (default)
node src/db/migrate.mjs

# Migrate NBA
LEAGUE=nba node src/db/migrate.mjs

# Migrate Europe database
LEAGUE=europe node src/db/migrate.mjs
```

### Programmatic Migrations in the ETL

When running the loader stage of the ETL:
```bash
node run.js --step=load
```
The pipeline programmatically executes any pending migrations dynamically on database initialization, ensuring the database schema is fully updated.
