# Find Your Armenian

A people-search app for finding likely-Armenian people by company, role, or location. It uses Apify for discovery, Gemini for planning + validation, stores every run locally, and ranks candidates with transparent evidence instead of claiming identity with certainty.

## APIs it needs

| API | Required? | What it does | Notes |
|-----|-----------|--------------|-------|
| **Apify** | Yes | Discovers people (LinkedIn profile search, Google-SERP web search, optional roster scrape, profile enrichment) | `APIFY_TOKEN`. Free plan works (~$5/mo credit); a typical search costs ~$0.10–0.20. |
| **Google Gemini** | Recommended | Plans the search and validates/reranks candidates | Vertex "Express" API keys (starting `AQ.`) work **only** via the `aiplatform.googleapis.com` publisher endpoint — the default. Without a key the pipeline still runs on deterministic heuristics. |
| Telegram | Optional | Chat interface (`npm run bot`) | `TELEGRAM_BOT_TOKEN`. |

## Pipeline

Discovery combines multiple engines and merges the results (deduped by LinkedIn URL):

1. **Structured LinkedIn people search** (`harvestapi/linkedin-profile-search`) — the primary engine. Filters by company / location / job title and biases toward Armenians. Highest precision.
2. **Web search** (`apify/rag-web-browser`) — cheap Google-SERP queries of the form `site:linkedin.com/in <company/terms> Armenian`, plus surname-OR batches for open/location searches. Strong company-affiliation recall.
3. **Company roster** (`george.the.developer/linkedin-company-employees-scraper`) — optional, off by default (most expensive); a broad roster then filtered locally.
4. **Profile enrichment** (`anchor/linkedin-profile-enrichment`) — full bios for borderline candidates, so the LLM judge reasons over real evidence rather than a short snippet. Cost-capped.

Candidates are then scored by a tiered Armenian-name model (curated surnames + suffix variants with Persian/Chinese/Western disambiguation), identity/community/location signals, and company-affiliation verification. If a Gemini key is set, Gemini reranks them with a numeric rubric and assigns display buckets. Everything is cached and saved as durable contacts, evidence, leads, and notes.

### Modes

Two modes trade quality against cost (set per search; **Quality is the default**):

- **Quality** — best possible results, cost is not a constraint. Runs Gemini planning + reranking, pulls **full** LinkedIn bios, enriches borderline candidates, and does a **surname sweep**: extra `harvestapi` passes filtered by the top Armenian surnames (`lastNames[]`) so it finds Armenians who never write "Armenian" on their profile — the biggest recall gap. Uses the strongest model (`gemini-3.5-flash`), generous timeouts, and retries the flaky LinkedIn scraper. Costs ~$1+ per company search (the sweep is ~$0.10/surname); tune with `APIFY_SURNAME_SEED_COUNT`.
- **Fast** — a cheap preview: short profiles, no surname sweep, no enrichment, no planning, tight timeouts.

Both surface an auditable trace (plan, tool runs, cache hits, validation).

## Local Run

```bash
cp .env.example .env
# Add APIFY_TOKEN in .env
npm start
```

Open `http://localhost:3000`.

## Docker Run

```bash
docker build -t find-your-armenian .
docker run --rm \
  --env-file .env \
  -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  find-your-armenian
```

If your Jetson is on Tailscale, open `http://<tailscale-device-name>:3000` or `http://<tailscale-ip>:3000` from another device on the tailnet.

## Configuration

```bash
PORT=3000
DATA_DIR=./data
APIFY_TOKEN=
APIFY_MODE=cache-first
APIFY_MAX_RESULTS=8
APIFY_REQUEST_TIMEOUT_MS=300000
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

## Data Stored Locally

Runtime data is written under `data/` and ignored by git:

- `data/raw-runs/`: raw Apify outputs keyed by actor/input hash.
- `data/contacts.json`: durable contact intelligence cache with aliases, evidence, sources, and last matched query.
- `data/profiles.json`: normalized people profiles.
- `data/searches.json`: user query history and result IDs.
- `data/leads.json`: saved lead status and notes.

## API

- `POST /api/search` with `{ "query": "Find Armenians at OpenAI", "refresh": false }`
- `GET /api/leads`
- `POST /api/leads` with `{ "personId": "...", "status": "contacted", "notes": "..." }`
- `GET /api/health`

## Validation

```bash
npm run validate
```

## Cost

On Apify's free plan (~$5/mo credit) a typical search costs roughly $0.10–0.20 (structured profile-search page + a couple of cheap web queries + a few enrichments), so ~25–40 fresh searches before the credit resets. `cache-first` mode (the default) reuses cached actor runs, so repeated or replayed searches are free. Tune cost with `APIFY_PROFILE_SEARCH_ENABLED`, `APIFY_ENRICH_ENABLED`, `APIFY_ENRICH_MAX_PROFILES`, and `APIFY_MAX_RESULTS`.

## Quick live check

```bash
node scripts/live-check.mjs "Find Armenians who work at OpenAI" fast
node scripts/live-check.mjs "Armenian AI founders in San Francisco" fast
```

Prints the ranked candidates with evidence, confidence, and Gemini's Armenian-confidence label.

## Next Steps

- Add ScaleKit auth and partition saved leads by user (see `SCALEKIT.md`).
- Resolve harvestapi's obfuscated `/in/ACw...` profile URLs to public vanity URLs before enrichment for broader enrichment coverage.
- Add a named-person search path (exact-name templates + single-profile enrichment).
