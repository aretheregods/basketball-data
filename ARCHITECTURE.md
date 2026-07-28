# Architectural Blueprint & Engineering Manual

This document defines the strict architectural theory, infrastructure design, data pipelines, and engineering standards for the **LikelyHigh Basketball ETL Pipeline**. It acts as our "Rules of the Road" to ensure modularity, platform portability, execution stability, and team alignment as the platform scales to support more global basketball competitions.

---

## 1. Core Philosophy & Architectural Theory

The Basketball-Data Core is engineered around **four core pillars**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ARCHITECTURAL PILLARS                          │
├───────────────────┬───────────────────┬───────────────────┬─────────────┤
│ 1. PORTABILITY    │ 2. PIPELINE-FIRST │ 3. CONTRACT       │ 4. GRACEFUL │
│ Zero-Dependency   │ Idempotent,       │ STRICTNESS        │ FAIL-SAFE   │
│ SQLite Engine via │ Decoupled,        │ Schema Validation │ Unplayed    │
│ node:sqlite       │ Isolated Stages   │ at Source Boundaries│ Skeletons   │
└───────────────────┴───────────────────┴───────────────────┴─────────────┘
```

### Pillar 1: Zero-Dependency Local Staging & Absolute Portability
To eliminate compile-time errors (`node-gyp` rebuilds), native C++ library version drift, and GLIBC mismatches on diverse environments (macOS, CentOS, Alpine, Debian), the storage architecture relies **exclusively** on the Node.js built-in `node:sqlite` (`DatabaseSync`) driver.
* External heavy query builders (like Knex) or standard `sqlite3` packages are completely avoided in the runtime ingestion pipeline.
* Migration execution is powered by a zero-dependency custom runner in `src/db/migrate.mjs` that resolves target database instances dynamically using the `LEAGUE` environment variable.

### Pillar 2: Decoupled, Idempotent 4-Stage Sequential Execution
The pipeline is structured as an assembly of isolated stages that flow in a strict sequence:
$$\text{Extract (Stage 1)} \longrightarrow \text{Transform (Stage 2)} \longrightarrow \text{Load (Stage 3)} \longrightarrow \text{Sync (Stage 4)}$$
* Each stage is **idempotent**: running a stage multiple times with the same input yields identical outcomes without data duplication or state leakage.
* Raw fetched payloads are stored unmodified on disk. Transformation logic is decoupled from network extraction, enabling offline metric re-computation from local caches.

### Pillar 3: Schema Validation at Source Boundaries
Every raw document pulled from external REST endpoints or scraped from HTML is verified immediately against its corresponding JSON Schema in `/schemas/<league>/boxscore.json` via `ajv` before being written to disk. This stops upstream upstream structural shifts from corrupting down-stream databases or transformations.

### Pillar 4: "Don't Break the Chain" Graceful Failure Boundaries
Because global basketball API endpoints are prone to rate limits, geographical blocks, and sudden unannounced schedule changes, the pipeline implements defensive error isolation:
* **HTTP Backoff**: The `HTTPClient` implements an exponential backoff retry loop. To prevent subclass method override conflicts and nested URL-doubling during retries, recursive retry calls utilize `HTTPClient.prototype.request.call(this, ...)` instead of `this.request(...)`.
* **Skeletal Fallbacks**: When extracting European games, individual box score fetch errors are caught, log a warning, and write a schema-compliant "Unplayed" skeletal record to disk instead of failing the entire multi-year run.

---

## 2. End-to-End Data Pipeline Architecture

The following diagram maps out the physical data flows, network boundaries, and disk boundaries:

```
                            [ WEB / API SOURCES ]
        (WNBA CDN, stats.nba.com, Proballers, Genius Sports API, etc.)
                                    │
                                    │ (HTTP GET via HTTPClient / Playwright)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        STAGE 1: EXTRACT (Network)                      │
│                                                                        │
│  * Harvest season game slugs via scraper clients.                      │
│  * Parse trailing unique game ID segments.                            │
│  * Execute schema check: ajv.validate(schemas/<league>/boxscore.json)  │
│  * Save Raw JSON to data/raw/<league>/<year>/<gameId>.json             │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   │ (File I/O Reads)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       STAGE 2: TRANSFORM (CPU Bound)                   │
│                                                                        │
│  * Extract and clean text fields (BaseNormalizer.cleanString).         │
│  * Dual name representation: Original vs Transliterated ASCII-clean.   │
│  * Load team aliases ONCE outside loops (prevents I/O bottlenecks).    │
│  * Compute TS%, eFG%, and GmSC metrics using standardized formulas.    │
│  * Cache output in data/transformed/<league>/<year>/transformed.json   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   │ (Direct Memory Array or File Rehydration)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        STAGE 3: LOAD (Database DDL)                    │
│                                                                        │
│  * Initialize SQLite staging database: data/SQL/<LEAGUE>.sqlite        │
│  * Run programmatic migrations (DatabaseSync table creation).          │
│  * Clear matching historical records (clean season-league idempotency) │
│  * Chunk insert arrays into batches of 100 rows (transaction-bound).   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   │ (Local Delta Collection: synced = 0)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        STAGE 4: SYNC (Wrangler Edge)                   │
│                                                                        │
│  * Pull delta records where local synced status is 0.                  │
│  * Compile temporary SQL transaction: data/temp/delta_<timestamp>.sql  │
│  * Spawn Wrangler CLI subprocess: wrangler d1 execute --remote         │
│  * On Success: Set local synced = 1, unlink temporary delta file.      │
│  * On Failure: Retain SQL file under data/temp/ for manual auditing.   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Multi-League Scraper & Engine Catalog

We utilize specialized scraper engines organized by league characteristics and technical providers.

```
                          [ EuropeScraper Orchestrator ]
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
    [ EuroleagueEngine ]        [ AcbEngine ]            [ Specialized Engines ]
  EuroLeague / EuroCup (E/U)    Liga ACB (A)               * FibaLiveStatsEngine (B)
  Direct REST API; rate limit   Next.js React Server       * SsrHydrationEngine (I)
  backoff throttling (>=5s)     Component State Parser     * DomesticRestEngine (K)
                                                           * Direct HTML parsers
```

### 3.1 Domestic and Continental Scraper Specifications

| League ID | Scraper Class | Prefix | Harvesting & Scaping Strategy |
| :--- | :--- | :--- | :--- |
| **wnba** | `WNBAScraper` | N/A | Fetches full season schedules from mobile CDN endpoints. Extracts box scores from `www.wnba.com/game/{gameId}` by locating the Next.js `__NEXT_DATA__` script tag and mapping the state to the legacy Stats API JSON schema for backward compatibility. |
| **nba** | `NBAScraper` | N/A | Pulls schedules from CDN endpoints, caching locally under `data/raw/nba/schedule_{year}.json`. Bypasses stats.nba.com to avoid Akamai blocks, extracting raw JSON state directly from `__NEXT_DATA__` on nba.com game pages. |
| **canada** | `CeblScraper` | N/A | REST HTTP Zero-Browser pipeline. Queries CEBL API (`api.data.cebl.ca`) for schedule, filters to active/completed matches to avoid scheduled placeholders, and fetches raw Genius Sports FIBA LiveStats `data.json` directly from Genius CDN. |
| **puertorico** | `BsnScraper` | B | Proballers league schedule harvester (League 270) returning matchups formatted as `matchup-B{year}_{gameCode}`. High-performance, browser-independent static HTML regex parser extracts box score stats quickly. |
| **mexico** | `LnbpScraper` | N/A | Proballers harvester (League 166). Downloads match pages and parses raw HTML tables using a fast, zero-dependency header-to-column mapper (`LnbpParser.mjs`). |
| **europe** | `EuropeScraper` | Multi | Master Router routing to specialized scraper engines using unique game ID prefixes. |

### 3.2 European Engine Sub-Routing Registry
The `EuropeScraper` maps individual game ID prefixes to distinct scraper engines, isolating local competition differences into technical provider implementations:

1. **`EuroleagueEngine` (Prefixes: 'E' - EuroLeague, 'U' - EuroCup)**
   * Directly hits EuroLeague API JSON endpoints.
   * Employs defensive 5-second backoff delays on encountering `HTTP 429` rate-limit errors.
2. **`AcbEngine` (Prefix: 'A' - Spanish Liga ACB)**
   * Bypasses heavy browser automation.
   * Extracts statistics by parsing Next.js React Server Component `self.__next_f.push` JS segments directly from webpage responses.
3. **`FibaLiveStatsEngine` (Prefix: 'B' - Basketball Champions League)**
   * Pulls raw data from the Genius Sports/FIBA LiveStats CDN directly using numeric match IDs.
4. **`SsrHydrationEngine` (Prefix: 'I' - Italian LBA)**
   * Fetches server-rendered Next.js pages and parses React SSR state hydrated within `<script id="__NEXT_DATA__">` tags.
5. **`DomesticRestEngine` (Prefix: 'K' - Lithuanian Betsafe LKL)**
   * Fetches high-performance JSON statistics directly from direct REST API endpoints (`/api/livestream/boxscore/{gameCode}`).
6. **Direct HTML Regex Scrapers (Prefixes: 'D' - German BBL, 'G' - Greek GBL, 'L' - French LNB, 'S' - Turkish BSL, 'Y' - Israeli Winner League, 'V' - Adriatic ABA)**
   * Standardized static page scrapers that download raw box score HTML, map dynamic column indices using regex-header mappers, and assemble unified schema outputs without loading active headless browsers during parsing.
   * Playwright is strictly limited to harvesting schedules or results page listing indices when APIs are unavailable, and is mock-bypassed in tests.

---

## 4. Mathematical Formulations & Advanced Stats Metrics

The transform stage computes standardized basketball metrics to enable cross-league statistical analysis.

### 4.1 True Shooting Percentage (TS%)
Measures a player's shooting efficiency by taking into account field goals, 3-point field goals, and free throws.
$$\text{TS\%} = \frac{\text{PTS}}{2 \times \left(\text{FGA} + 0.44 \times \text{FTA}\right)}$$
* **Edge Case Handling**: If $\text{FGA} + 0.44 \times \text{FTA} = 0$, $\text{TS\%} = 0.0000$.
* **Format**: Float rounded to 4 decimal places.

### 4.2 Effective Field Goal Percentage (eFG%)
Adjusts field goal percentage to account for the fact that a 3-point field goal is worth more than a 2-point field goal.
$$\text{eFG\%} = \frac{\text{FGM} + 0.5 \times \text{FG3M}}{\text{FGA}}$$
* **Edge Case Handling**: If $\text{FGA} = 0$, $\text{eFG\%} = 0.0000$.
* **Format**: Float rounded to 4 decimal places.

### 4.3 Game Score (GmSC)
Created by John Hollinger, this metric provides a rough measure of a player's productivity for a single game.
$$\text{GmSC} = \text{PTS} + 0.4 \times \text{FGM} - 0.7 \times \text{FGA} - 0.4 \times \left(\text{FTA} - \text{FTM}\right) + 0.7 \times \text{OREB} + 0.3 \times \text{DREB} + \text{STL} + 0.7 \times \text{AST} + 0.7 \times \text{BLK} - 0.4 \times \text{PF} - \text{TOV}$$
* **Format**: Float rounded to 1 decimal place.

### 4.4 Rounding Conventions & Unit Conversions
* **Mathematical Half-Up Rounding**: Implemented strictly for all statistics to prevent decimal truncation errors.
* **Plus/Minus**: Stored as a floating-point number rounded to 1 decimal place.
* **ISO-8601 Duration Parsing**: In `BaseNormalizer.parseMinutesToFloat`, ISO-8601 strings (e.g. `PT36M12.00S`) are converted to standard float minutes (e.g. `36.2`). Traditional `MM:SS` or plain `MM` formats are parsed similarly, with rounding to 1 decimal place.

---

## 5. Data Normalization & Entity Resolution

To prevent player duplication and database join mismatches across leagues with varied string conventions:

### Player Name Normalization
* `player_name` retains the original string (with all diacritics, accents, and casing intact).
* `normalized_name` is an ASCII-clean, transliterated counterpart using Unicode decomposition (`NFD` normalization) and stripping diacritics via character classes:
  $$\text{"Añgêl Špûr̃"} \longrightarrow \text{"Angel Spur"}$$
* **European Character Transliteration**: Cyrillic and Greek alphabets are converted to standard Latin equivalents via `BaseNormalizer.transliterate` to resolve names across continental and domestic box score listings safely.

### Team Alias Matching Optimization
* Team mappings (e.g., `config/europe_team_mappings.json`, `config/puertorico_team_mappings.json`) are parsed **exactly once** outside of the file transformation loops in Stage 2. This prevents CPU bottlenecks and disk-bound blocking.
* Unresolved team or player names are caught by the `EuropeanEntityResolver` and written to `data/unmapped_entities.json` to flag missing mappings during pipeline execution.

---

## 6. Database Staging & Production Sync (D1)

```
┌────────────────────────┐
│  data/SQL/*.sqlite     │ (Isolated Local SQLite Database Files)
└───────────┬────────────┘
            │
            ▼ (Gathers rows where synced = 0)
┌────────────────────────┐
│     Delta SQL File     │ (Saves to data/temp/delta_<timestamp>.sql)
└───────────┬────────────┘
            │
            ▼ (Spawns Wrangler CLI subprocess)
┌────────────────────────┐
│     Cloudflare D1      │ (Remote Edge SQL Store)
└────────────────────────┘
```

### Staging Mechanics
* Database files are segregated per league or continent (e.g. `data/SQL/WNBA.sqlite`, `data/SQL/EUROPE.sqlite`) to isolate failure domains.
* Connections are opened using Node's `DatabaseSync` on Stage 3 initialization.
* Old records for the targeted league and season are pruned in an open transaction before loading new batches to guarantee idempotency.
* Records are chunk-loaded in batches of **100 rows** to bypass the SQLite compiler parameters and variable limitation constraints.

### Sync Delta Generation
* Unsynced records (`synced = 0`) are selected.
* An `INSERT OR REPLACE` script is written to a temporary delta file under `data/temp/`.
* `wrangler d1 execute` is spawned as a subprocess.
* On clean return, a transaction updates `synced = 1` inside the local SQLite db, and the temporary file is deleted. On failure, local state remains `synced = 0`, and the `.sql` file remains written on disk for debugging.

---

## 7. Local Health Audit & Dashboard Server

The pipeline includes an active health checker under `src/audit/`:
* **Engine Checks**: Performs SQL sanity tests across local SQLite databases to detect:
  * Team-to-Player score mismatches.
  * Anomalously low minutes played.
  * Missing game box scores.
  * Count of unsynced game records pending D1 sync.
* **Server Security**: Spawns a lightweight local server on port `3000` (`server.mjs`). It secures command execution (rerunning stages) by applying strict parameter validation regexes and restricting CORS strictly to `localhost` loopback origins.

---

## 8. Strict Architectural Guardrails (Rules of the Road)

To maintain structural integrity as more developers or agents join the project, the following guidelines are **absolute** and must not be violated:

```
┌────────────────────────────────────────────────────────────────────────┐
│                         RULES OF THE ROAD                              │
├───────────────────────────────────┬────────────────────────────────────┤
│           ALLOWED ROAD            │          FORBIDDEN DETOUR          │
├───────────────────────────────────┼────────────────────────────────────┤
│ ✔ Schema-compliant empty fallbacks│ ✘ Editing build artifacts directly │
│   for unplayed European games.    │   (dist, target, build files)      │
│ ✔ Isolated Playwright harvesters  │ ✘ Modifying global process.env in  │
│   with complete test bypasses.    │   standard test runners (causes    │
│ ✔ Zero-dependency native modules  │   race-condition crashes)          │
│   over compiled C++ npm packages. │ ✘ Duplicating Stage 3/4 loaders   │
│ ✔ Adding custom schemas to track  │   (must reuse existing models)     │
│   external data structures.       │ ✘ Direct edits to pnpm-lock.yaml   │
└───────────────────────────────────┴────────────────────────────────────┘
```

1. **Source over Artifacts**: Never edit a compiled build artifact or compiled output file directly. Always locate the original source file under `src/`, modify it, and run the designated script to re-generate the asset.
2. **Standard Test Run Isolation**: Tests must never edit `process.env.NODE_ENV` globally. Instead, use instance-level configurations (like `scraper.bypassNetwork = false`) to isolate execution behavior and avoid parallel test suite interference.
3. **No Duplicate Load/Sync Pipelines**: When onboarding a new basketball league, you must register it in the master `run.js` orchestrator and output compatible datasets in Stage 2. Do not write custom SQLite insert blocks or wrangler synchronization loops for a single league.
4. **Offline Parser Browser Isolation**: Scrapers must split the "harvesting" of game index lists (which may utilize Playwright if necessary) from the "extraction" of statistics. Box score parsing must remain clean, browser-independent, regex-driven, or REST JSON-driven to allow lightweight offline execution.
5. **No pnpm-lock.yaml Direct Modifications**: Any package updates or dependency adjustments must be handled in `package.json` and executed via `pnpm install` so that pnpm resolves and locks dependencies deterministically.

---

By adhering strictly to these architectural boundaries, we preserve a modular, high-efficiency system that can reliably clean and load basketball datasets across the globe.
