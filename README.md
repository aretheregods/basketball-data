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

---

## Linux/Debian Installation & SQLite3 Support

If you run the ETL or migrations on Linux distributions (such as Debian or Ubuntu) with older GLIBC versions, you may encounter a compatibility error like:
```
/lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
```

### The Solution (Automatic)
The project root contains a `.npmrc` file with `build-from-source=true` configured. This forces `sqlite3` to compile locally from source during `pnpm install`, building the bundled SQLite version against your system's exact local GLIBC.

### Using System-Installed SQLite3 via APT
If you have `sqlite3` and `libsqlite3-dev` installed globally on your system (via `sudo apt install sqlite3 libsqlite3-dev`), you can optionally link the Node.js `sqlite3` package directly against your system's library by running:

```bash
pnpm install --sqlite=/usr
```
Alternatively, you can append `sqlite=/usr` to your local `.npmrc` file.
