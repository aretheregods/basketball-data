# Basketball-Data Core

This project implements a modular, high-performance ETL pipeline to scrape, clean, process, load, and sync basketball player and team-level statistics across various international leagues and continents.

---

## Supported Leagues & Competitions

The ETL pipeline supports box scores, play-by-play (PBP) events, and advanced statistical computations across **9 global league categories**:

1. **NBA (`nba`)**: North American Men's Professional Basketball (includes Play-by-Play and 5-on-5 stint tracking).
2. **WNBA (`wnba`)**: Women's National Basketball Association (includes Play-by-Play and 5-on-5 stint tracking).
3. **Europe (`europe`)**: European continental and domestic competitions (EuroLeague `E`, EuroCup `U`, Basketball Champions League `B`, Spanish Liga ACB `A`, French LNB `L`, Italian LBA `I`, Greek GBL `G`, German BBL `D`, Lithuanian LKL `K`, Adriatic ABA `V`, Turkish BSL `S`, Israeli Winner League `Y`).
4. **Mexico (`mexico`)**: Liga Nacional de Baloncesto Profesional (LNBP).
5. **Canada (`canada`)**: Canadian Elite Basketball League (CEBL).
6. **Puerto Rico (`puertorico`)**: Baloncesto Superior Nacional (BSN).
7. **South America (`southamerica`)**: South American competitions (Basketball Champions League Americas `bcla`, Liga Sudamericana `lsb`, NBB Brazil `nbb`, LNB Argentina `lnb`, LUB Uruguay `lub`).
8. **Australia NBL (`nbl`)**: Australian National Basketball League (includes Play-by-Play and 5-on-5 stint tracking).
9. **Asia (`asia`)**: Asian continental and domestic competitions (East Asia Super League `easl`, WASL `wasl`, BCL Asia `bcl_asia`, FIBA Asia CC `fiba_asia_cc`, B.League Japan `bleague`, KBL South Korea `kbl`, PBA Philippines `pba`, CBA China `cba`, TPBL Taiwan `tpbl`).

---

## Quick Terminal Usage Guide

All ETL operations are coordinated through the central CLI runner `run.js`.

### Running the Full Pipeline

Execute all pipeline stages (`extract` -> `transform` -> `load` -> `sync`) for target leagues and season years:

```bash
# Default execution (WNBA for current year)
node run.js

# Specific league and season years
node run.js --league=nba --years=2024,2025

# Multiple leagues and sub-competitions
node run.js --league=asia --competitions=easl,bleague,kbl --years=2024
node run.js --league=southamerica --competitions=all --years=2024
```

### Supported CLI Flags

| Flag | Format | Default | Description |
|---|---|---|---|
| `--league` | `--league=nba,europe` | `wnba` | Comma-separated target leagues (`nba`, `wnba`, `europe`, `mexico`, `canada`, `puertorico`, `southamerica`, `nbl`, `asia`). |
| `--competitions` | `--competitions=easl,bleague` | `euroleague` (Europe), `bcla` (South America), `bcl_asia` (Asia) | Comma-separated list or `all` for sub-competitions within Europe, South America, or Asia. |
| `--years` | `--years=2024,2025` | Current Year | Comma-separated list of target season years. |
| `--step` | `--step=extract,transform` | `extract,transform,load,sync` | Comma-separated pipeline stages (`extract`, `transform`, `load`, `sync`, `audit`). |
| `--database` | `--database=my_d1_db` | `likelyhigh_db` | Cloudflare D1 production database binding name for `sync`. |
| `--dryRun` / `--dry-run` | `--dryRun=true` | `false` | Generates local SQL delta files without invoking Wrangler remote execution. |
| `--boxscore-type` / `--type` | `--type=pbp` | `traditional` | Boxscore type (`traditional`, `advanced`, `pbp`). |
| `--game` / `--games` | `--game=0022400123` | None | Filters extraction and processing to specific game IDs or slug substrings. |

---

## Database & Migrations

To avoid native C++ compilation issues and GLIBC version mismatches, the project uses a custom, zero-dependency migrations engine powered by Node.js's built-in `node:sqlite` (`DatabaseSync`) module.

SQLite database files are stored per league or continent in `data/SQL/` (e.g. `NBA.sqlite`, `WNBA.sqlite`, `EUROPE.sqlite`, `MEXICO.sqlite`, `CANADA.sqlite`, `PUERTORICO.sqlite`, `SOUTHAMERICA.sqlite`, `NBL.sqlite`, `ASIA.sqlite`).

### Running Migrations Manually via CLI

To run or check migrations manually across any local database, set the `LEAGUE` environment variable:

```bash
# Migrate WNBA (default)
node src/db/migrate.mjs

# Migrate NBA
LEAGUE=nba node src/db/migrate.mjs

# Migrate Europe
LEAGUE=europe node src/db/migrate.mjs

# Migrate Australia NBL
LEAGUE=nbl node src/db/migrate.mjs

# Migrate Asia
LEAGUE=asia node src/db/migrate.mjs
```

### Programmatic Migrations in the ETL

When running the loader stage of the ETL:
```bash
node run.js --step=load
```
The loader automatically executes any pending migrations dynamically on database initialization, ensuring the target database schema is fully up-to-date.

---

## Play-by-Play Data Ingestion (NBA, WNBA, & NBL)

The pipeline supports play-by-play (PBP) event feeds, shot locations, and 5-on-5 stint interval tracking for NBA, WNBA, and Australia NBL via the `--type=pbp` flag:

```bash
# WNBA Play-by-Play
node run.js --league=wnba --years=2024 --type=pbp --step=extract,transform,load

# NBA Play-by-Play
node run.js --league=nba --years=2024,2025 --type=pbp --step=extract,transform,load

# Australia NBL Play-by-Play
node run.js --league=nbl --years=2024 --type=pbp --step=extract,transform,load
```

---

## ETL Local Health Audit & Web Dashboard

You can run automated database sanity checks (detecting score mismatches, low minutes anomalies, missing boxscores, and pending sync counts) via the CLI or web dashboard UI:

```bash
# Run CLI health report & launch web dashboard server on http://localhost:3000
node run.js --step=audit
```
