# Basketball ETL Pipeline Documentation

Welcome to the documentation for the **LikelyHigh Basketball ETL Pipeline**. This pipeline is designed to scrape, clean, process, load, and sync team and player-level statistics from various global basketball leagues.

The pipeline architecture is structured into decoupled, sequential stages coordinated by a root CLI runner (`run.js`). This layout ensures modularity, testability, and isolated failure domains.

---

## Table of Contents

- [Pipeline Architecture Overview](#pipeline-architecture-overview)
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
| `--league` | `--league=wnba` or `--league=wnba,nba` | `wnba` | Comma-separated list of target leagues to process. |
| `--years` | `--years=2023` or `--years=2022,2023` | Current Year | Comma-separated list of target season years to process. |
| `--step` | `--step=extract,transform` | `extract,transform,load,sync` | Comma-separated list of pipeline stages to run. Useful for isolated stage execution. |
| `--database` | `--database=my_d1_db` | `likelyhigh_db` | Name of the target Cloudflare D1 database for the `sync` stage. |
| `--dryRun` / `--dry-run` | `--dryRun=true` or `--dry-run=true` | `false` | If true, generates temporary SQL delta files but skips actual Wrangler sync execution. |
| `--boxscore-type` / `--type` | `--boxscore-type=advanced` | `traditional` | Scraper configuration type to resolve traditional or advanced box score endpoints. |

---

## Stage 1: Extract (`1-extract.mjs`)

**Extract Stage** manages HTTP requests and persists the unmodified raw source data to local disk files.

### Key Operations
1. Queries the target scraper client for season game slugs (e.g., `nyl-vs-con-0012300001`).
2. Extracts unique numeric game IDs from the trailing segment of each slug.
3. Downloads the game's full boxscore payload from the API with retry-safe HTTP clients.
4. Asserts that the received response matches the JSON Schema (e.g. `schemas/wnba/boxscore.json`).
5. Saves the validated raw JSON directly to the directory.

### Directory Structure & Paths
- **Raw output directory**: `data/raw/<league>/<year>/`
- **Filename pattern**: `<gameId>.json` (e.g., `data/raw/wnba/2023/0042300211.json`)

### Input Example (WNBA API payload outline)
```json
{
  "resource": "boxscore",
  "parameters": { "GameID": "0042300211" },
  "resultSets": [
    {
      "name": "PlayerStats",
      "headers": ["GAME_ID", "PLAYER_ID", "PLAYER_NAME", "PTS", "FGM", "FGA", "FTM", "FTA", "OREB", "DREB", "STL", "AST", "BLK", "PF", "TO"],
      "rowSet": [
        ["0042300211", 1630123, "Añgêl Špûr̃", 20, 8, 15, 3, 4, 2, 5, 2, 4, 1, 3, 2]
      ]
    }
  ]
}
```

### Outputs
- Pure raw local JSON files representing original source datasets.
- Schema verification guarantees that data contracts are not broken before transforming.

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

### Directory Structure & Paths
- **Cached output directory**: `data/transformed/<league>/<year>/`
- **Output file**: `transformed.json`

### Output Structure Details (`transformed.json` outline)
```json
{
  "players": [
    {
      "game_id": "0042300211",
      "player_id": 1630123,
      "player_name": "Añgêl Špûr̃",
      "normalized_name": "Angel Spur",
      "team_id": 1611661319,
      "team_abbreviation": "LVA",
      "team_city": "Las Vegas",
      "start_position": "F",
      "comment": "",
      "min": "34:12",
      "fgm": 8,
      "fga": 15,
      "fg_pct": 0.533,
      "fg3m": 1,
      "fg3a": 2,
      "fg3_pct": 0.5,
      "ftm": 3,
      "fta": 4,
      "ft_pct": 0.75,
      "oreb": 2,
      "dreb": 5,
      "reb": 7,
      "ast": 4,
      "stl": 2,
      "blk": 1,
      "tov": 2,
      "pf": 3,
      "pts": 20,
      "plus_minus": 12.0,
      "ts_pct": 0.5967,
      "efg_pct": 0.5667,
      "game_score": 17.5,
      "season": "2023",
      "league": "wnba",
      "synced": 0
    }
  ],
  "teams": [
    {
      "game_id": "0042300211",
      "team_id": 1611661319,
      "team_name": "Las Vegas Aces",
      "team_abbreviation": "LVA",
      "team_city": "Las Vegas",
      "min": "200:00",
      "fgm": 32,
      "fga": 70,
      "fg_pct": 0.457,
      "fg3m": 15,
      "fg3a": 20,
      "fg3_pct": 0.75,
      "ftm": 15,
      "fta": 20,
      "ft_pct": 0.75,
      "oreb": 10,
      "dreb": 25,
      "reb": 35,
      "ast": 18,
      "stl": 8,
      "blk": 5,
      "tov": 12,
      "pf": 15,
      "pts": 85,
      "plus_minus": 15.0,
      "ts_pct": 0.5393,
      "efg_pct": 0.5643,
      "season": "2023",
      "league": "wnba",
      "synced": 0
    }
  ]
}
```

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

### Database Paths & Migrations Management
- **Local DB Location**: `data/SQL/<LEAGUE>.sqlite` (e.g., `data/SQL/WNBA.sqlite`). Note: The `data/SQL/` directory is registered in `.gitignore` to prevent tracking staging databases in Git.
- **Multi-League Support**: We have distinct database files per league or continent (e.g., `WNBA.sqlite`, `NBA.sqlite`, `EUROPE.sqlite`).
- **Dynamic Knexfile Resolution**: The `knexfile.js` configuration dynamically resolves the target league database using the `LEAGUE` environment variable (defaulting to `WNBA`). For example:
  ```bash
  # To run migrations for NBA:
  LEAGUE=nba pnpm exec knex migrate:latest --env development

  # To check status for Europe:
  LEAGUE=europe pnpm exec knex migrate:status --env development
  ```
- **Programmatic Loader Migrations**: When Stage 3 (`load`) initializes a connection to any database via `initDatabase(league)`, it programmatically invokes `await db.migrate.latest()` to ensure all tables are correctly scaffolded and up-to-date automatically.
- **Debian / Older GLIBC Compilation**: On Linux platforms with older library versions (such as Debian Bookworm), the pre-built `sqlite3` binary may fail with a `GLIBC_2.38 not found` error. To resolve this, a project-local `.npmrc` is configured with `build-from-source=true` to automatically compile the package during `pnpm install`. If you have system-installed `sqlite3` and `libsqlite3-dev` libraries via APT, you can instruct `sqlite3` to link against it dynamically:
  ```bash
  pnpm install --sqlite=/usr
  ```

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

### Dynamic Wrangler Subprocess Spawning
- Spawns a native Node.js `child_process.spawn` worker executing under the system shell:
  ```bash
  wrangler d1 execute <databaseName> --remote --file=<temporarySqlFile>
  ```
- Captures standard streams (`stdout`, `stderr`) to provide inline terminal diagnostics.
- Returns clear exit status signals.

### Sync Transactions & Delta Safety
- Unsynced delta updates are gathered by locating rows marked with `synced = 0`.
- Generates localized SQLite `INSERT OR REPLACE` syntax lines to a temporary directory `data/temp/temp_delta_<league>_<year>_<timestamp>.sql`.
- If Wrangler sync executes cleanly without a non-zero exit code:
  - Updates the synced status of local staging columns to `1` within a safe transaction block.
  - Deletes the temporary `.sql` script from local space.
- If an execution error occurs:
  - Holds local `synced` flags at `0`.
  - Preserves the temporary delta `.sql` file in `data/temp/` for inspection and debugging.

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

### 2. `team_game_stats` Table Schema

| Column Name | Database Type | Primary Key | Description |
|---|---|---|---|
| `game_id` | `VARCHAR` | Yes (Composite) | Unique identifier for the game. |
| `team_id` | `INTEGER` | Yes (Composite) | Unique identifier for the team. |
| `team_name` | `VARCHAR` | No | Complete official team name. |
| `team_abbreviation`| `VARCHAR` | No | Team shorthand code. |
| `team_city` | `VARCHAR` | No | Localized city. |
| `min` | `VARCHAR` | No | Total squad played minutes. |
| `fgm` | `INTEGER` | No | Team Field Goals Made. |
| `fga` | `INTEGER` | No | Team Field Goals Attempted. |
| `fg_pct` | `FLOAT` | No | Team Field Goal Percentage. |
| `fg3m` | `INTEGER` | No | Team Three-Point Made. |
| `fg3a` | `INTEGER` | No | Team Three-Point Attempted. |
| `fg3_pct` | `FLOAT` | No | Team Three-Point Percentage. |
| `ftm` | `INTEGER` | No | Team Free Throws Made. |
| `fta` | `INTEGER` | No | Team Free Throws Attempted. |
| `ft_pct` | `FLOAT` | No | Team Free Throw Percentage. |
| `oreb` | `INTEGER` | No | Team Offensive Rebounds. |
| `dreb` | `INTEGER` | No | Team Defensive Rebounds. |
| `reb` | `INTEGER` | No | Team Total Rebounds. |
| `ast` | `INTEGER` | No | Team Assists. |
| `stl` | `INTEGER` | No | Team Steals. |
| `blk` | `INTEGER` | No | Team Blocks. |
| `tov` | `INTEGER` | No | Team Turnovers. |
| `pf` | `INTEGER` | No | Team Personal Fouls. |
| `pts` | `INTEGER` | No | Total Team Points. |
| `plus_minus` | `FLOAT` | No | Team overall differential score. |
| `ts_pct` | `FLOAT` | No | Team True Shooting Percentage. |
| `efg_pct` | `FLOAT` | No | Team Effective Field Goal Percentage. |
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

### 3. Run Isolated Stages (Extraction & Transformation Only)
Run only extraction and transformation stages without touching databases:
```bash
node run.js --step=extract,transform --years=2023
```

### 4. Running Database Loader Independently (Re-loading Cache)
If you have already extracted and transformed raw data, you can boot up Stage 3 (`load`) to populate your local SQLite databases without making any network API requests:
```bash
node run.js --step=load --years=2023
```
*Note: Stage 3 automatically detects the lack of memory-cache and reads processed cached files from `data/transformed/wnba/2023/transformed.json`.*

### 5. Executing Dry-Run Sync Operations
Generate the delta SQL scripts under `data/temp/` and audit them manually without executing Wrangler on remote servers:
```bash
node run.js --step=sync --years=2023 --dryRun=true
```

### 6. Syncing to a Custom Cloudflare D1 Database
Identify unsynced rows and pipe updates to a production-specific edge database:
```bash
node run.js --step=sync --years=2023 --database=prod_basketball_analytics_db
```

### 7. Customizing Box Score Scraper Resolution Types
Request advanced stats endpoints instead of traditional ones using the type flag:
```bash
node run.js --league=wnba --years=2023 --boxscore-type=advanced
```
*Can also use `--type=advanced` shortcut.*

---

## Troubleshooting & FAQs

### Q: Why did Stage 4 [SYNC] crash with "Wrangler execution failed"?
* **Root Cause**: This happens if the Wrangler CLI isn't installed globally, isn't logged in, or the target database name doesn't match your Cloudflare configuration.
* **Resolution**:
  1. Verify your Wrangler CLI login status by running:
     ```bash
     npx wrangler whoami
     ```
  2. Verify that your Cloudflare D1 database exists and is named correctly in your Cloudflare dashboard:
     ```bash
     npx wrangler d1 list
     ```
  3. Ensure your `wrangler.toml` file contains the correct D1 binding ID.

### Q: What happens if a single network request fails in Stage 1?
* **Design Strategy**: The `HTTPClient` module is configured to handle intermittent connection limits gracefully. It retries requests on rate-limiting (`429`) or server errors (`500`) up to **3 times** with **exponential backoff**.
* If a critical failure persists after all retry attempts, the pipeline will throw a fatal error and halt execution of the remaining stages for that season to ensure data integrity.

### Q: How can I clean and reset staging SQLite databases?
* Because the loader uses Knex migrations/schema creations inline, you can simply remove the SQLite database files safely. The pipeline will recreate them automatically on the next execution:
  ```bash
  rm -rf data/SQL/*.sqlite
  ```

### Q: How do I verify if my schema matches the API expectations?
* The pipeline automatically checks all fetched datasets during Stage 1 execution against drafts located inside the `schemas/` folder. If a source API contract has shifted, it throws a localized schema error and halts execution to protect downstream data types.
* To check schemas manually, execute the built-in test suites:
  ```bash
  pnpm test
  ```
