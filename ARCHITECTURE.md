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
Every raw document pulled from external REST endpoints or scraped from HTML is verified immediately against its corresponding JSON Schema in `/schemas/<league>/boxscore.json` via `ajv` before being written to disk. This stops upstream structural shifts from corrupting downstream databases or transformations.

### Pillar 4: "Don't Break the Chain" Graceful Failure Boundaries
Because global basketball API endpoints are prone to rate limits, geographical blocks, and sudden unannounced schedule changes, the pipeline implements defensive error isolation:
* **HTTP Backoff**: The `HTTPClient` implements an exponential backoff retry loop. To prevent subclass method override conflicts and nested URL-doubling during retries, recursive retry calls utilize `HTTPClient.prototype.request.call(this, ...)` instead of `this.request(...)`.
* **Skeletal Fallbacks**: When extracting European or Asian games, individual box score fetch errors are caught, log a warning, and write a schema-compliant "Unplayed" skeletal record to disk instead of failing the entire multi-year run.

---

## 2. End-to-End Data Pipeline Architecture

The following diagram maps out the physical data flows, network boundaries, and disk boundaries:

```
                            [ WEB / API SOURCES ]
        (WNBA CDN, stats.nba.com, Proballers, Genius Sports API, RealGM, etc.)
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

We utilize specialized scraper engines organized by league characteristics and technical providers across 9 distinct league categories.

### 3.1 Domestic and Continental Scraper Specifications

| League Category | Scraper Class | Prefix / Format | Harvesting & Scraping Strategy | Database File |
| :--- | :--- | :--- | :--- | :--- |
| **wnba** | `WNBAScraper` | N/A | Fetches full season schedules from mobile CDN endpoints. Extracts box scores and play-by-play events (`--type=pbp`). | `WNBA.sqlite` |
| **nba** | `NBAScraper` | N/A | Pulls schedules from CDN endpoints, caching locally under `data/raw/nba/schedule_{year}.json`. Bypasses stats.nba.com to avoid Akamai blocks, extracting raw JSON state directly from `__NEXT_DATA__` on nba.com game pages. Supports Play-by-Play (`--type=pbp`). | `NBA.sqlite` |
| **europe** | `EuropeScraper` | Multi (`E`,`U`,`B`,`A`,`L`,`I`,`G`,`D`,`K`,`V`,`S`,`Y`) | Master Router routing to specialized scraper engines (`EuroleagueEngine`, `AcbEngine`, `FibaLiveStatsEngine`, `SsrHydrationEngine`, `DomesticRestEngine`, HTML parsers). | `EUROPE.sqlite` |
| **mexico** | `LnbpScraper` | N/A | Proballers harvester (League 166). Downloads match pages and parses raw HTML tables using a fast, zero-dependency header-to-column mapper (`LnbpParser.mjs`). | `MEXICO.sqlite` |
| **canada** | `CeblScraper` | N/A | REST HTTP Zero-Browser pipeline. Queries CEBL API (`api.data.cebl.ca`) for schedule and fetches raw Genius Sports FIBA LiveStats `data.json` directly from Genius CDN. | `CANADA.sqlite` |
| **puertorico** | `BsnScraper` | B | Proballers league schedule harvester (League 270) returning matchups formatted as `matchup-B{year}_{gameCode}`. High-performance, browser-independent static HTML regex parser. | `PUERTORICO.sqlite` |
| **southamerica** | `SouthAmericaScraper` | SA / Comp | Targets Proballers index for BCLA (`bcla`), LSB (`lsb`), NBB Brazil (`nbb`), LNB Argentina (`lnb`), LUB Uruguay (`lub`). Fast static HTML regex parsing. | `SOUTHAMERICA.sqlite` |
| **nbl** | `NblScraper` | N/A | Fetches Australia NBL games, supporting traditional boxscores and FIBA LiveStats Play-by-Play (`NblPbpHarvester` / `NblPbpTransformer` for `--type=pbp`). | `NBL.sqlite` |
| **asia** | `AsiaScraper` | Comp | Targets EASL, WASL, BCL Asia, FIBA Asia CC, B.League, KBL, PBA, CBA, TPBL using `AsiaHarvester` and dynamic parser resolution (FIBA LiveStats REST JSON, RealGM KBL HTML, Proballers HTML). | `ASIA.sqlite` |

---

## 4. Mathematical Formulations & Advanced Stats Metrics

The transform stage computes standardized basketball metrics to enable cross-league statistical analysis.

### 4.1 True Shooting Percentage (TS%)
$$\text{TS\%} = \frac{\text{PTS}}{2 \times \left(\text{FGA} + 0.44 \times \text{FTA}\right)}$$

### 4.2 Effective Field Goal Percentage (eFG%)
$$\text{eFG\%} = \frac{\text{FGM} + 0.5 \times \text{FG3M}}{\text{FGA}}$$

### 4.3 Game Score (GmSC)
$$\text{GmSC} = \text{PTS} + 0.4 \times \text{FGM} - 0.7 \times \text{FGA} - 0.4 \times \left(\text{FTA} - \text{FTM}\right) + 0.7 \times \text{OREB} + 0.3 \times \text{DREB} + \text{STL} + 0.7 \times \text{AST} + 0.7 \times \text{BLK} - 0.4 \times \text{PF} - \text{TOV}$$

---

## 5. Database Staging & Production Sync (D1)

SQLite database files are segregated per league/continent under `data/SQL/`:
- `data/SQL/NBA.sqlite`
- `data/SQL/WNBA.sqlite`
- `data/SQL/EUROPE.sqlite`
- `data/SQL/MEXICO.sqlite`
- `data/SQL/CANADA.sqlite`
- `data/SQL/PUERTORICO.sqlite`
- `data/SQL/SOUTHAMERICA.sqlite`
- `data/SQL/NBL.sqlite`
- `data/SQL/ASIA.sqlite`

### Staging & Sync Mechanics
* Connections are opened using Node's native `DatabaseSync` on Stage 3 initialization.
* Target season/league records are cleared in an open transaction before loading new batches to guarantee idempotency.
* Unsynced records (`synced = 0`) are selected during Stage 4, compiled to `.sql` transaction scripts, and piped to Cloudflare D1 using Wrangler.

---

## 6. Local Health Audit & Dashboard Server

The local health engine under `src/audit/` runs SQL sanity tests across local databases:
* **Checks**: Mismatches between team total score and sum of player points, low-minutes anomalies, missing boxscores, and pending unsynced counts.
* **Server**: Spawns a lightweight audit server (`server.mjs`) listening on `0.0.0.0:3000` to serve the Vanilla JS visual dashboard.
