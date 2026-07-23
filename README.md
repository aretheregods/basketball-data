# Basketball-Data Core

This project implements a modular, high-performance ETL pipeline to scrape, clean, process, load, and sync basketball player and team-level statistics across various international leagues and continents.

## Supported Leagues

- **NBA**: National Basketball Association
- **WNBA**: Women's National Basketball Association
- **Europe**: Specialized orchestrator mapping and running major European continental and domestic competitions:
  - *Continental*: EuroLeague (`euroleague`), EuroCup (`eurocup`), Basketball Champions League (`bcl`).
  - *Genius Sports/FIBA LiveStats*: ABA League (`aba`), LKL Lithuania (`lkl`), GBL Greece (`gbl`).
  - *SSR Hydration*: Liga ACB Spain (`acb`), LBA Italy (`lba`), LNB Pro A France (`lnb`).
  - *Direct REST APIs*: BBL Germany (`bbl`), BSL Turkey (`bsl`), Israeli Premier League (`israel`).

---

## Running the ETL Pipeline

We coordinate execution via the root `run.js` script:

```bash
# Default (runs WNBA current season)
node run.js

# Scrape, Transform, Load, and Sync specific leagues & years
node run.js --league=wnba,nba --years=2023,2024

# Scrape specific European competitions (e.g., Liga ACB and EuroLeague)
node run.js --league=europe --competitions=acb,euroleague --years=2025

# Run a complete European sweep (Continental + all 9 domestic leagues)
node run.js --league=europe --competitions=all --years=2025
```

---

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
