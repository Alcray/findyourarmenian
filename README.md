# Find Your Armenian

A people-search app for finding likely-Armenian people by company, role, or location. It uses Apify for discovery, Gemini for planning + validation, stores every run locally, and ranks candidates with transparent evidence instead of claiming identity with certainty.

## APIs it needs

| API | Required? | What it does | Notes |
|-----|-----------|--------------|-------|
| **Apify** | Yes for live search | Discovers people (LinkedIn profile search, web search, optional roster scrape, profile enrichment) | `APIFY_TOKEN`. Every actor run has result and charge caps; repeated searches reuse verified local data and actor caches. |
| **Google Gemini** | Recommended | Plans the search and validates/reranks candidates | Vertex "Express" API keys (starting `AQ.`) work **only** via the `aiplatform.googleapis.com` publisher endpoint — the default. Without a key the pipeline still runs on deterministic heuristics. |
| Telegram | Optional | Chat interface (`npm run bot`) | `TELEGRAM_BOT_TOKEN` plus a private `TELEGRAM_ALLOWED_CHAT_IDS` allowlist. |

## Pipeline

Discovery combines multiple engines and merges the results (deduped by LinkedIn URL):

1. **Structured LinkedIn people search** (`harvestapi/linkedin-profile-search`) — the primary engine. Company display names are resolved to the full LinkedIn company URLs required by the actor, then combined with location/job-title filters.
2. **Web search** (`apify/rag-web-browser`) — cheap Google-SERP queries of the form `site:linkedin.com/in <company/terms> Armenian`, plus surname-OR batches for open/location searches. Strong company-affiliation recall.
3. **Company roster** (`george.the.developer/linkedin-company-employees-scraper`) — optional, off by default (most expensive); a broad roster then filtered locally.
4. **Profile enrichment** (`anchor/linkedin-profile-enrichment`) — full bios for borderline candidates, so the LLM judge reasons over real evidence rather than a short snippet. Cost-capped.

Candidates are then scored by a tiered Armenian-name model (curated surnames + suffix variants with Persian/Chinese/Western disambiguation), identity/community/location signals, and strict current-company verification. Requested roles, topics, and locations must be present in the candidate data; they are never copied from the query. If a Gemini key is set, Gemini reranks candidates with a numeric rubric and assigns display buckets. Strong results become reusable contacts; weaker identity guesses can be reviewed without polluting the permanent contact list.

### Modes

Two modes trade quality against cost (set per search; **Quality is the default**):

- **Quality** — full profiles, wider web discovery, enrichment, Gemini planning/reranking, and generous timeouts. A deep surname sweep is available through `APIFY_SURNAME_SEED_COUNT`, but remains opt-in because each surname is a separately billed profile-search run.
- **Fast** — a cheap preview: short profiles, no surname sweep, no enrichment, no planning, tight timeouts.

Both surface an auditable trace (plan, tool runs, cache hits, validation). Actor runs are never automatically retried, because retrying a timed-out synchronous run can charge twice.

## Local Run

```bash
cp .env.example .env
# Add APIFY_TOKEN in .env
npm start
```

Open `http://localhost:3000`.

For a password-protected local run, set both `AUTH_PASSWORD` and
`AUTH_SESSION_SECRET`. Authentication is optional only in local development;
production starts fail-closed when either value is missing.

## Docker Run

```bash
docker build -t find-your-armenian .
docker run --rm \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  find-your-armenian
```

If your Jetson is on Tailscale, open `http://<tailscale-device-name>:3000` or `http://<tailscale-ip>:3000` from another device on the tailnet.
Add that device name/IP to `ALLOWED_HOSTS` first; network Host headers are denied by default.

## Railway Deployment

This repository includes a Railway configuration and a production Docker image.
The image initializes the mounted data directory as root, then drops privileges
and runs the application as the unprivileged `node` user.

1. Create a Railway project from the GitHub repository and branch you want to deploy.
2. Add a persistent volume mounted at `/app/data`.
3. Add the required secrets and conservative production settings:

```bash
AUTH_PASSWORD=<unique password of at least 16 characters>
AUTH_SESSION_SECRET=<separate random secret of at least 32 bytes>
APIFY_TOKEN=<current Apify token>
GEMINI_API_KEY=<current Gemini key>

APIFY_MODE=cache-first
APIFY_MAX_RESULTS=8
APIFY_REQUEST_TIMEOUT_MS=90000
APIFY_MAX_TOTAL_CHARGE_USD=0.25
APIFY_DISCOVERY_CONCURRENCY=1
APIFY_SURNAME_SEED_COUNT=0
APIFY_COMPANY_EMPLOYEES_ENABLED=false
APIFY_ENRICH_MAX_PROFILES=6
GEMINI_ENABLED=true
```

4. Generate a public domain and enable Railway Serverless/App Sleeping.

Railway provides the public domain and healthcheck host automatically; both are
added to the HTTP Host allowlist. `/api/health` and `/api/ready` remain public for
platform probes, while the UI, contacts, history, notes, configuration, and paid
search endpoints require a signed-in session. Never commit production secrets.

The Git repository intentionally excludes `data/`, so a new Railway volume starts
empty. Import existing local data only after authentication is enabled, and keep
the volume attached to preserve contacts and search history across deployments.

## Configuration

```bash
PORT=3000
DATA_DIR=./data
HOST=127.0.0.1
ALLOWED_HOSTS=
AUTH_PASSWORD=
AUTH_SESSION_SECRET=
AUTH_SESSION_TTL_SECONDS=604800
# AUTH_COOKIE_SECURE=true
APIFY_TOKEN=
APIFY_MODE=cache-first
APIFY_MAX_RESULTS=8
APIFY_REQUEST_TIMEOUT_MS=90000
APIFY_MAX_TOTAL_CHARGE_USD=0.25
APIFY_DISCOVERY_CONCURRENCY=3
APIFY_COMPANY_EMPLOYEES_ACTOR=george.the.developer/linkedin-company-employees-scraper
APIFY_COMPANY_MAX_EMPLOYEES=25
APIFY_SEARCH_ACTOR=apify/rag-web-browser
APIFY_MCP_URL=https://mcp.apify.com/?tools=actors,docs,apify/rag-web-browser,george.the.developer/linkedin-company-employees-scraper
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
GEMINI_API_BASE=https://aiplatform.googleapis.com/v1/publishers/google/models
GEMINI_ENABLED=true
```

Modes:

- `cache-first`: reuse local searches and raw Apify outputs before spending credits.
- `live`: run Apify for every search.
- `demo`: use synthetic demo data without Apify.
- `fixture`: strict tracked test data; a missing actor/input fixture fails instead of using cache, demo data, or the network.

`cache-first` no longer silently substitutes demo people when `APIFY_TOKEN` is missing. It may reuse a valid live cache, but an uncached request fails with a configuration error. This prevents test/demo results from being mistaken for real people.

## Data Stored Locally

Runtime data is written under `data/` and ignored by git:

- `data/raw-runs/`: raw Apify outputs keyed by actor/input hash.
- `data/contacts.json`: durable contact intelligence cache with aliases, evidence, sources, and last matched query.
- `data/profiles.json`: normalized people profiles.
- `data/searches.json`: user query history, result IDs, and immutable result snapshots.
- `data/.sandbox/`: isolated demo/fixture state, never merged with live people.
- `data/leads.json`: saved lead status and notes.

On Railway, the same files live in the persistent volume at `/app/data`.

## API

- `POST /api/search` with `Content-Type: application/json` and `{ "query": "Find Armenians at OpenAI", "refresh": false }`
- `GET /api/leads`
- `POST /api/leads` with `Content-Type: application/json` and `{ "personId": "...", "status": "contacted", "notes": "..." }`
- `GET /api/health`
- `GET /api/ready` (503 when live discovery is not configured)

All routes except the two health probes and the login/logout flow require a
valid session whenever authentication is enabled.

## Validation

```bash
npm test
npm run validate
npm run bench
npm run bench:gate
```

The default benchmark is fully offline. It uses sanitized tracked fixtures, an isolated temporary data directory, and semantic accepted/rejected profile labels. Use `npm run bench:live` only when you intentionally want to spend API credits on a diagnostic run.

## Cost

`cache-first` mode (the default) reuses both trusted contacts and cached actor runs. `APIFY_MAX_TOTAL_CHARGE_USD` is a ceiling for each actor run, not the whole multi-run search. Control aggregate exposure with the number of web/surname/enrichment runs as well as `APIFY_MAX_RESULTS` and `APIFY_ENRICH_MAX_PROFILES`; `APIFY_SURNAME_SEED_COUNT` is opt-in. Actual actor pricing can change, so check the actor pages before raising these limits.

## Quick live check

```bash
node scripts/live-check.mjs "Find Armenians who work at OpenAI" fast
node scripts/live-check.mjs "Armenian AI founders in San Francisco" fast
```

Prints the ranked candidates with evidence, confidence, and Gemini's Armenian-confidence label.

## Next Steps

- Before sharing the app with multiple independent users, partition saved data by user and replace the process-local JSON/job queue with a durable database/queue (Supabase is a reasonable free-tier option). The current password gate is designed for a single trusted owner or small trusted group.
- Keep the Telegram chat allowlist enabled; do not expose paid search commands to arbitrary bot users.
- Resolve harvestapi's obfuscated `/in/ACw...` profile URLs to public vanity URLs before enrichment for broader enrichment coverage.
- Add a named-person search path (exact-name templates + single-profile enrichment).
