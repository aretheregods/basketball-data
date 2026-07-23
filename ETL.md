# Basketball ETL Pipeline Documentation

Welcome to the documentation for the **LikelyHigh Basketball ETL Pipeline**. This pipeline is designed to scrape, clean, process, load, and sync team and player-level statistics from various global basketball leagues.

The pipeline architecture is structured into decoupled, sequential stages coordinated by a root CLI runner (`run.js`). This layout ensures modularity, testability, and isolated failure domains.

---

## Table of Contents

- [Pipeline Architecture Overview](#pipeline-architecture-overview)
- [CLI Entry Point & Options](#cli-entry-point--options)
- [European & Domestic Leagues Architecture](#european--domestic-leagues-architecture)
- [Stage 1: Extract (`1-extract.mjs`)](#stage-1-extract-1-extractmjs)
- [Stage 2: Transform (`2-transform.mjs`)](#stage-2-transform-2-transformmjs)
- [Stage 3: Load (`3-load.mjs`)](#stage-3-load-3-loadmjs)
- [Stage 4: Sync (`4-sync.mjs`)](#stage-4-sync-4-syncmjs)
- [Data Models & Schema Definitions](#data-models--schema-definitions)
- [In-Depth Execution Examples](#in-depth-execution-examples)
- [Troubleshooting & FAQs](#troubleshooting--faqs)

---

## Pipeline Architecture Overview

The ETL pipeline operates on a sequential 4-stage flow designed to go from network extraction to public edge synchronization.

```
┌──────────────┐     ┌───────────────┐     ┌─────────────┐     ┌──────────────┐
│  1. EXTRACT  │ ──> │ 2. TRANSFORM  │ ──> │   3. LOAD   │ ──> │   4. SYNC    │
└──────────────┘     └───────────────┘     └─────────────┘     └──────────────┘
  Fetch Raw APIs        Clean & Compute      Batch Insert to     Push Delta to
  Validate Schemas     Advanced Metrics      Local SQLite DB     Cloudflare D1
```

Each stage performs a highly targeted task:
1. **Extract**: Pulls game-level JSON payloads directly from source APIs, validates them against JSON schemas, and stores them unmodified as raw assets on disk.
2. **Transform**: Parses raw payloads, handles character normalizing, cleans whitespace, calculates advanced performance metrics (e.g., TS%, eFG%, Game Score), and caches processed outputs as structured JSON.
3. **Load**: Boots up local isolated SQLite databases (per league) via Knex, executes schemas, cleans existing historical records for idempotency, and performs transaction-bound batch operations.
4. **Sync**: Detects local unsynced delta rows, compiles target INSERT OR REPLACE SQL command files, spawns Wrangler CLI to update production databases in Cloudflare D1, and marks rows as synchronized.

---

## CLI Entry Point & Options

The global ETL execution is triggered via the root command-line script:

```bash
node run.js [options]
```

### Supported Flags & Options

| Flag | Format | Default | Description |
|---|---|---|---|
| `--league` | `--league=wnba` or `--league=europe` | `wnba` | Comma-separated list of target leagues to process. |
| `--competitions` | `--competitions=acb,lba` | `euroleague` | For European runs: comma-separated list of target competitions or `all` to run all continental & domestic tournaments. |
| `--years` | `--years=2023` or `--years=2024,2025` | Current Year | Comma-separated list of target season years to process. |
| `--step` | `--step=extract,transform` | `extract,transform,load,sync` | Comma-separated list of pipeline stages to run. Useful for isolated stage execution. |
| `--database` | `--database=my_d1_db` | `likelyhigh_db` | Name of the target Cloudflare D1 database for the `sync` stage. |
| `--dryRun` / `--dry-run` | `--dryRun=true` or `--dry-run=true` | `false` | If true, generates temporary SQL delta files but skips actual Wrangler sync execution. |
| `--boxscore-type` / `--type` | `--boxscore-type=advanced` | `traditional` | Scraper configuration type to resolve traditional or advanced box score endpoints. |

---

## European & Domestic Leagues Architecture

Our European ETL pipeline supports unified scheduling, extraction, and transformation across multiple continental tournaments and domestic leagues inside `data/SQL/EUROPE.sqlite`. These leagues are handled by specialized provider engines depending on their technical backends:

```
                      ┌─────────────────────────────────────────┐
                      │    Domestic European Leagues Target     │
                      └────────────────────┬────────────────────┘
                                           │
         ┌─────────────────────────────────┼─────────────────────────────────┐
         ▼                                 ▼                                 ▼
┌─────────────────┐               ┌─────────────────┐               ┌─────────────────┐
│ FIBA LiveStats  │               │ SSR Hydration   │               │ Public API      │
│ (Genius Sports) │               │ (__NEXT_DATA__) │               │ (REST / JSON)   │
├─────────────────┤               ├─────────────────┤               ├─────────────────┤
│ • ABA League    │               │ • Liga ACB      │               │ • BBL (Germany) │
│ • LKL (Lithua.) │               │ • LBA (Italy)   │               │ • BSL (Turkey)  │
│ • GBL (Greece)  │               │ • LNB (France)  │               │ • Israeli League│
└─────────────────┘               └─────────────────┘               └─────────────────┘
```

1. **FibaLiveStatsEngine** (`aba`, `lkl`, `gbl`): Retrieves unauthenticated, standardized Genius Sports live JSON data feeds directly via game codes.
2. **SsrHydrationEngine** (`acb`, `lba`, `lnb`): Downloads match HTML pages and parses Next.js script blocks (`__NEXT_DATA__` or `window.__INITIAL_STATE__`) to retrieve pristine raw box score states.
3. **DomesticRestEngine** (`bbl`, `bsl`, `israel`): Connects to modular internal REST endpoints exposed by league APIs.

---

## Stage 1: Extract (`1-extract.mjs`)

**Extract Stage** manages HTTP requests and persists the unmodified raw source data to local disk files.

### Key Operations
1. Queries the target scraper client for season game slugs (e.g., `nyl-vs-con-0012300001` or `realmadrid-vs-fcbarcelona-ACB2025_2001`).
2. Extracts unique numeric game IDs from the trailing segment of each slug.
3. Downloads the game's full boxscore payload from the API with retry-safe HTTP clients.
4. Asserts that the received response matches the JSON Schema (e.g. `schemas/europe/boxscore.json`).
5. Saves the validated raw JSON directly to the directory.

### Directory Structure & Paths
- **Raw output directory**: `data/raw/<league>/<year>/`
- **Filename pattern**: `<gameId>.json` (e.g., `data/raw/europe/2025/ACB2025_2001.json`)

---

## Stage 2: Transform (`2-transform.mjs`)

**Transform Stage** reads raw local JSON files, maps columns, processes player and team names, and computes advanced basketball statistical equations.

### Normalization Logic
- **`BaseNormalizer.cleanString`**: Strips leading/trailing whitespace and compresses multi-space blocks.
- **`BaseNormalizer.normalizeName`**: Normalizes string encoding (decomposes combined characters) and strips all accents and diacritics to provide accent-safe searching/sorting.
  - **Example**: `"Añgêl Špûr̃"` becomes `"Angel Spur"`.
- **Diacritics Preservation**:
  - `player_name` retains the original string (with diacritics intact, after trimming/collapsing spaces).
  - `normalized_name` contains the clean ASCII counterpart with diacritics removed.

---

## Stage 3: Load (`3-load.mjs`)

**Load Stage** reads transformed structures (either passed directly via memory cache or rehydrated from disk cache files) and saves them to local SQLite database engines.

### Key Operations
1. Initializes a local SQLite instance located at `data/SQL/<LEAGUE>.sqlite` using the Knex query builder.
2. Asserts that SQLite database tables (`player_game_stats`, `team_game_stats`) exist or creates them on start.
3. Wraps database write cycles inside an isolated database Transaction (`trx`) block:
   - **Idempotency Clean**: Removes all pre-existing records matching the targeting league and season year to allow clean, hazard-free reruns of the pipeline.
   - **Batch Loading**: Inserts rows in small transaction-safe chunks of **100 rows** to avoid SQLite variables and statement limits.
4. Closes connections gracefully after execution.

---

## Stage 4: Sync (`4-sync.mjs`)

**Sync Stage** uploads local SQLite increments to production database engines hosted on Cloudflare D1.

---

## Data Models & Schema Definitions

### 1. `player_game_stats` Table Schema

| Column Name | Database Type | Primary Key | Description |
|---|---|---|---|
| `game_id` | `VARCHAR` | Yes (Composite) | Unique identifier for the game. |
| `player_id` | `INTEGER` | Yes (Composite) | Unique identifier for the player. |
| `player_name` | `VARCHAR` | No | Original name with preserved diacritics. |
| `normalized_name` | `VARCHAR` | No | ASCII clean version of the name without accents. |
| `team_id` | `INTEGER` | No | Target team identifier. |
| `team_abbreviation`| `VARCHAR` | No | Short name/code for the team. |
| `team_city` | `VARCHAR` | No | Team's localized city. |
| `start_position` | `VARCHAR` | No | Player starter code (e.g. `F`, `G`, `C`) or blank. |
| `comment` | `VARCHAR` | No | Inactive reasons or notes (e.g. `DND - Coach's Decision`). |
| `min` | `VARCHAR` | No | Game minutes played (formatted as `MM:SS` or `MM`). |
| `fgm` | `INTEGER` | No | Field Goals Made. |
| `fga` | `INTEGER` | No | Field Goals Attempted. |
| `fg_pct` | `FLOAT` | No | Field Goal Percentage. |
| `fg3m` | `INTEGER` | No | Three-Point Field Goals Made. |
| `fg3a` | `INTEGER` | No | Three-Point Field Goals Attempted. |
| `fg3_pct` | `FLOAT` | No | Three-Point Percentage. |
| `ftm` | `INTEGER` | No | Free Throws Made. |
| `fta` | `INTEGER` | No | Free Throws Attempted. |
| `ft_pct` | `FLOAT` | No | Free Throw Percentage. |
| `oreb` | `INTEGER` | No | Offensive Rebounds. |
| `dreb` | `INTEGER` | No | Defensive Rebounds. |
| `reb` | `INTEGER` | No | Total Rebounds. |
| `ast` | `INTEGER` | No | Assists. |
| `stl` | `INTEGER` | No | Steals. |
| `blk` | `INTEGER` | No | Blocks. |
| `tov` | `INTEGER` | No | Turnovers. |
| `pf` | `INTEGER` | No | Personal Fouls. |
| `pts` | `INTEGER` | No | Total Points. |
| `plus_minus` | `FLOAT` | No | Plus/Minus factor. |
| `ts_pct` | `FLOAT` | No | Computed True Shooting Percentage. |
| `efg_pct` | `FLOAT` | No | Computed Effective Field Goal Percentage. |
| `game_score` | `FLOAT` | No | Computed Player Game Score. |
| `season` | `VARCHAR` | No | Target season year. |
| `league` | `VARCHAR` | No | Source league identifier. |
| `synced` | `INTEGER` | No | Local staging state (0 = unsynced, 1 = synced). |

---

## In-Depth Execution Examples

### 1. Default Pipeline Run (Run All Stages for WNBA - Current Year)
Runs all stages (`extract` -> `transform` -> `load` -> `sync`) for the WNBA league for the current calendar year, using default database configurations:
```bash
node run.js
```

### 2. Targeting Specific Season Years & Multiple Leagues
Scrape and process both the 2022 and 2023 seasons for WNBA:
```bash
node run.js --league=wnba --years=2022,2023
```

### 3. Run European Continental Tournaments Only
Scrapes and processes EuroLeague, EuroCup, and Basketball Champions League for the 2024 season:
```bash
node run.js --league=europe --competitions=euroleague,eurocup,bcl --years=2024
```

### 4. Run Specific European Domestic Leagues (e.g., Spanish ACB & Italian LBA)
Scrapes and processes Liga ACB and Lega Basket Serie A for the 2025 season:
```bash
node run.js --league=europe --competitions=acb,lba --years=2025
```

### 5. Run Complete European Sweep (Continental & Domestic Leagues)
Scrapes and processes all twelve target European leagues concurrently for the 2025 season:
```bash
node run.js --league=europe --competitions=all --years=2025
```

---

## Troubleshooting & FAQs

### Q: Why did Stage 4 [SYNC] crash with "Wrangler execution failed"?
* **Root Cause**: This happens if the Wrangler CLI isn't installed globally, isn't logged in, or the target database name doesn't match your Cloudflare configuration.
* **Resolution**: Ensure Wrangler is logged in and D1 database exists.

### Q: What happens if a single network request fails in Stage 1?
* **Design Strategy**: The `HTTPClient` module is configured to handle intermittent connection limits gracefully. It retries requests on rate-limiting (`429`) or server errors (`500`) up to **3 times** with **exponential backoff**.
* For the European pipeline, if a fetch fails, a valid schema-compliant fallback "Unplayed" skeleton is written to disk to allow the rest of the multi-competition season to continue without crashing.
