# Basketball ETL Pipeline Documentation

Welcome to the documentation for the **LikelyHigh Basketball ETL Pipeline**. This pipeline is designed to scrape, clean, process, load, and sync team and player-level statistics from various global basketball leagues.

The pipeline architecture is structured into decoupled, sequential stages coordinated by a root CLI runner (`run.js`). This layout ensures modularity, testability, and isolated failure domains.

---

## Table of Contents

- [Pipeline Architecture Overview](#pipeline-architecture-overview)
- [Supported Leagues & Sub-Competitions](#supported-leagues--sub-competitions)
- [CLI Entry Point & Options](#cli-entry-point--options)
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
1. **Extract**: Pulls game-level JSON payloads directly from source APIs or HTML pages, validates them against JSON schemas, and stores them unmodified as raw assets on disk.
2. **Transform**: Parses raw payloads, handles character normalizing, cleans whitespace, calculates advanced performance metrics (e.g., TS%, eFG%, Game Score), and caches processed outputs as structured JSON.
3. **Load**: Boots up local isolated SQLite databases (per league) via Node's built-in `node:sqlite` module, executes schemas/migrations, cleans existing historical records for idempotency, and performs transaction-bound batch operations.
4. **Sync**: Detects local unsynced delta rows, compiles target INSERT OR REPLACE SQL command files, spawns Wrangler CLI to update production databases in Cloudflare D1, and marks rows as synchronized.

---

## Supported Leagues & Sub-Competitions

The pipeline supports 9 major league categories and numerous domestic and international sub-competitions:

| League Code (`--league`) | Description & Included Competitions | Database File |
|---|---|---|
| `nba` | North American NBA Men's Professional Basketball (Traditional, Advanced, Play-by-Play). | `data/SQL/NBA.sqlite` |
| `wnba` | Women's National Basketball Association (Traditional, Advanced, Play-by-Play). | `data/SQL/WNBA.sqlite` |
| `europe` | European Basketball: EuroLeague (`E`), EuroCup (`U`), Basketball Champions League (`B`), Spanish Liga ACB (`A`), French LNB (`L`), Italian LBA (`I`), Greek GBL (`G`), German BBL (`D`), Lithuanian LKL (`K`), Adriatic ABA (`V`), Turkish BSL (`S`), Israeli Winner League (`Y`). | `data/SQL/EUROPE.sqlite` |
| `mexico` | Liga Nacional de Baloncesto Profesional (LNBP). | `data/SQL/MEXICO.sqlite` |
| `canada` | Canadian Elite Basketball League (CEBL). | `data/SQL/CANADA.sqlite` |
| `puertorico` | Baloncesto Superior Nacional (BSN). | `data/SQL/PUERTORICO.sqlite` |
| `southamerica` | South American Basketball: BCLA (`bcla`), LSB (`lsb`), NBB Brazil (`nbb`), LNB Argentina (`lnb`), LUB Uruguay (`lub`). | `data/SQL/SOUTHAMERICA.sqlite` |
| `nbl` | Australian National Basketball League (Traditional, Play-by-Play). | `data/SQL/NBL.sqlite` |
| `asia` | Asian Basketball: East Asia Super League (`easl`), WASL (`wasl`), BCL Asia (`bcl_asia`), FIBA Asia CC (`fiba_asia_cc`), B.League Japan (`bleague`), KBL South Korea (`kbl`), PBA Philippines (`pba`), CBA China (`cba`), TPBL Taiwan (`tpbl`). | `data/SQL/ASIA.sqlite` |

---

## CLI Entry Point & Options

The global ETL execution is triggered via the root command-line script:

```bash
node run.js [options]
```

### Supported Flags & Options

| Flag | Format | Default | Description |
|---|---|---|---|
| `--league` | `--league=wnba` or `--league=asia,southamerica` | `wnba` | Comma-separated list of target leagues to process (`nba`, `wnba`, `europe`, `mexico`, `canada`, `puertorico`, `southamerica`, `nbl`, `asia`). |
| `--competitions` | `--competitions=easl,bleague` | Default competition for targeted league (`euroleague`, `bcla`, `bcl_asia`) | Comma-separated list or `all` for sub-competitions within Europe, South America, or Asia. |
| `--years` | `--years=2023` or `--years=2024,2025` | Current Year | Comma-separated list of target season years to process. |
| `--step` | `--step=extract,transform` | `extract,transform,load,sync` | Comma-separated list of pipeline stages to run (`extract`, `transform`, `load`, `sync`, `audit`). |
| `--database` | `--database=my_d1_db` | `likelyhigh_db` | Name of the target Cloudflare D1 database for the `sync` stage. |
| `--dryRun` / `--dry-run` | `--dryRun=true` or `--dry-run=true` | `false` | If true, generates temporary SQL delta files but skips actual Wrangler sync execution. |
| `--boxscore-type` / `--type` | `--boxscore-type=advanced` or `--type=pbp` | `traditional` | Scraper configuration type (`traditional`, `advanced`, `pbp`). |
| `--game` / `--games` | `--game=0022400123` | None | Filter pipeline execution to matching game ID or slug substring. |

---

## Stage 1: Extract (`1-extract.mjs`)

**Extract Stage** manages HTTP requests and persists the unmodified raw source data to local disk files.

### Key Operations
1. Queries the target scraper client for season game slugs (e.g., `nyl-vs-con-0012300001` or `ryukyu-vs-seoul-EASL2024_10001`).
2. Extracts unique game IDs or codes from game slugs.
3. Downloads the game's full boxscore or play-by-play payload from the API or webpage with retry-safe HTTP clients.
4. Asserts that the received response matches the JSON Schema (e.g. `schemas/wnba/boxscore.json` or `schemas/asia/boxscore.json`).
5. Saves the validated raw JSON directly to disk under `data/raw/<league>/<year>/` (or `data/raw/<league>/pbp/<year>/` for play-by-play).

### Directory Structure & Paths
- **Raw boxscore output directory**: `data/raw/<league>/<year>/`
- **Raw play-by-play output directory**: `data/raw/<league>/pbp/<year>/`
- **Filename pattern**: `<gameId>.json` (e.g., `data/raw/wnba/2023/0042300211.json`)

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

### Computed Statistical Formulas
1. **True Shooting Percentage (TS%)**:
   $$\text{TS\%} = \frac{\text{PTS}}{2 \times (\text{FGA} + 0.44 \times \text{FTA})}$$
   *Normalized to 4 decimal places.*
2. **Effective Field Goal Percentage (eFG%)**:
   $$\text{eFG\%} = \frac{\text{FGM} + 0.5 \times \text{FG3M}}{\text{FGA}}$$
   *Normalized to 4 decimal places.*
3. **Game Score (GmSC)**:
   $$\text{GmSC} = \text{PTS} + 0.4 \times \text{FGM} - 0.7 \times \text{FGA} - 0.4 \times (\text{FTA} - \text{FTM}) + 0.7 \times \text{OREB} + 0.3 \times \text{DREB} + \text{STL} + 0.7 \times \text{AST} + 0.7 \times \text{BLK} - 0.4 \times \text{PF} - \text{TOV}$$
   *Normalized to 1 decimal place.*
4. **Team/Bench Points Variance Reconciliation (European & Asian Leagues)**:
   In European and Asian basketball leagues, the sum of individual player points does not always equal the official final team score due to unassigned points (e.g. coach/bench technical free throws, or incomplete source boxscore sheets).
   To maintain mathematical agreement and pass SQL integrity checks, the Transform stage calculates:
   $$\text{Variance} = \text{Team Score} - \sum \text{Individual Player Points}$$
   If $\text{Variance} \neq 0$ and the team score is greater than 0, a virtual `"Team/Bench"` pseudo-player row (using ID `<team_id>_team`) is automatically appended with `pts` set to the variance.

---

## Stage 3: Load (`3-load.mjs`)

**Load Stage** reads transformed structures (either passed directly via memory cache or rehydrated from disk cache files) and saves them to local SQLite database engines.

### Key Operations
1. Initializes a local SQLite instance located at `data/SQL/<LEAGUE>.sqlite` using Node.js native `DatabaseSync` driver.
2. Asserts that SQLite database tables (`player_game_stats`, `team_game_stats`, `game_play_by_play`, `game_stints`) exist or creates them on start via migration scripts.
3. Wraps database write cycles inside an isolated database Transaction (`trx`) block:
   - **Idempotency Clean**: Removes all pre-existing records matching the targeting league and season year to allow clean, hazard-free reruns of the pipeline.
   - **Batch Loading**: Inserts rows in small transaction-safe chunks of **100 rows** to avoid SQLite variables and statement limits.
4. Closes connections gracefully after execution.

---

## Stage 4: Sync (`4-sync.mjs`)

**Sync Stage** uploads local SQLite increments to production database engines hosted on Cloudflare D1.

### Sync Pipeline Workflow

```
┌───────────────────────────┐
│ Local SQLite Staging DB   │  (Identify rows where 'synced' = 0)
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Compile Local SQL delta   │  (Generates raw SQLite-compatible INSERT statements)
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Spawns Wrangler Process   │  (wrangler d1 execute <dbName> --remote --file=<sql>)
└─────────────┬─────────────┘
              │
              ├──────────────────────────────┐
              ▼ (On Success)                 ▼ (On Error)
┌───────────────────────────┐  ┌───────────────────────────┐
│ Update 'synced' = 1 local │  │ Preserve SQL delta file   │
└───────────────────────────┘  │ for audit & debugging     │
                               └───────────────────────────┘
```

---

## Data Models & Schema Definitions

### 1. `player_game_stats` Table Schema

| Column Name | Database Type | Primary Key | Description |
|---|---|---|---|
| `game_id` | `VARCHAR` | Yes (Composite) | Unique identifier for the game. |
| `team_id` | `INTEGER` / `VARCHAR` | Yes (Composite) | Unique identifier for the team. |
| `player_id` | `INTEGER` / `VARCHAR` | Yes (Composite) | Unique identifier for the player. |
| `player_name` | `VARCHAR` | No | Original name with preserved diacritics. |
| `normalized_name` | `VARCHAR` | No | ASCII clean version of the name without accents. |
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

### 2. Play-by-Play & Stint Schemas (`game_play_by_play` and `game_stints`)

#### `game_play_by_play` Table Schema
- `event_id`: Composite synthetic key (`{game_id}_{action_number}_{index}`)
- `game_id`: Game identifier
- `period`: Period / Quarter
- `clock`: Display clock (e.g. `"11:42"` or `"05:30"`)
- `seconds_remaining`: Clock remaining in current period (float seconds)
- `game_seconds_remaining`: Total regulation/game seconds remaining
- `event_type`: EventMsgType code (1=Make, 2=Miss, 3=FT, 4=Reb, 5=TO, 6=Foul, 8=Sub, etc.)
- `sub_type`: ActionType sub-code
- `team_id`: Acting team ID
- `player_id`: Acting player ID
- `secondary_player_id`: Assist/Block/Foul drawer ID
- `description`: Action description string
- `home_score`: Running home score
- `away_score`: Running away score
- `loc_x`: Court X coordinate
- `loc_y`: Court Y coordinate
- `shot_distance`: Shot distance in feet
- `is_scoring_play`: Binary flag (1 if scoring play, 0 otherwise)

#### `game_stints` Table Schema
- `stint_id`: Composite synthetic key (`{game_id}_{period}_{stint_index}`)
- `game_id`: Game identifier
- `period`: Period / Quarter
- `start_clock`: Stint start clock string
- `end_clock`: Stint end clock string
- `duration_seconds`: Stint duration in seconds
- `home_lineup_hash`: JSON array of sorted on-court home player IDs
- `away_lineup_hash`: JSON array of sorted on-court away player IDs
- `home_pts`: Home points scored during stint
- `away_pts`: Away points scored during stint
- `possessions`: Estimated stint possessions (`FGA + 0.44 * FTA - OREB + TOV`)

---

## In-Depth Execution Examples

### 1. Default Pipeline Run (Run All Stages for WNBA - Current Year)
```bash
node run.js
```

### 2. Targeting Specific Asian Competitions
Run the Asian basketball pipeline for EASL and B.League Japan:
```bash
node run.js --league=asia --competitions=easl,bleague --years=2024
```

To run all Asian competitions (`easl`, `wasl`, `bcl_asia`, `fiba_asia_cc`, `bleague`, `kbl`, `pba`, `cba`, `tpbl`):
```bash
node run.js --league=asia --competitions=all --years=2024
```

### 3. Play-by-Play Ingestion Examples (NBA, WNBA, NBL)
Ingest play-by-play events and calculate 5-on-5 lineups/stints:
```bash
# WNBA Play-by-Play
node run.js --league=wnba --years=2024 --type=pbp --step=extract,transform,load

# NBA Play-by-Play
node run.js --league=nba --years=2024,2025 --type=pbp --step=extract,transform,load

# Australia NBL Play-by-Play
node run.js --league=nbl --years=2024 --type=pbp --step=extract,transform,load
```

### 4. Running Database Loader Independently (Re-loading Cache)
If raw data has already been transformed, re-populate local SQLite databases without making network requests:
```bash
node run.js --league=nbl --years=2024 --step=load
```

### 5. Running Health Audit CLI & Server Dashboard
Execute database integrity checks across all database files under `data/SQL/`:
```bash
node run.js --step=audit
```

---

## Troubleshooting & FAQs

### Q: How can I reset or re-process staging SQLite databases without redownloading raw files?
* Re-run transformation and loading steps for the target league:
  ```bash
  node run.js --league=asia --years=2024 --step=transform,load
  ```
  Stage 3 (`load`) automatically purges existing records for that season/league inside a clean transaction before batch inserting updated records.

### Q: Why did Stage 4 [SYNC] crash with "Wrangler execution failed"?
* Ensure Wrangler CLI is installed, authenticated (`npx wrangler whoami`), and the target `--database` binding matches your Cloudflare account.
