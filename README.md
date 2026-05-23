# Find Your Armenian

A minimal hackathon app for finding likely Armenian people by company, role, or location. It uses Apify for web/profile discovery, stores every run locally, and ranks candidates with transparent evidence instead of claiming identity with certainty.

## Why Not LangChain Yet?

For this MVP, the agent is built from scratch as a small deterministic pipeline:

1. Parse the user query.
2. Expand it into Apify search queries.
3. For company searches, run the LinkedIn Company Employees actor first.
4. Check the local cache.
5. Run Apify only on cache misses or forced refresh.
6. Normalize profiles.
7. Ask Gemini to strictly validate/rerank candidates when a Gemini key is configured.
8. Score Armenian/company/role/location evidence.
9. Save leads and notes.

This is better for the hackathon because it is tiny, inspectable, Docker-friendly on Jetson Orin Nano, and has zero npm dependencies. LangChain can be added later if the app needs tool routing, multi-step memory, or LLM-based extraction.

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
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
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

## Next Steps

- Add ScaleKit auth and partition saved leads by user.
- Add a dedicated LinkedIn Apify Actor once you choose the exact actor and input schema.
- Add LLM extraction for richer profile parsing from long Apify text results.
