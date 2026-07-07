# Find Your Armenian

A minimal hackathon app for finding likely Armenian people by company, role, or location. It uses Apify for web/profile discovery, stores every run locally, and ranks candidates with transparent evidence instead of claiming identity with certainty.

## Agent Flow

The experiment branch runs a LangGraph agent:

1. Check the exact-query cache.
2. Run a LangGraph agent with a contact-cache lookup node.
3. Ask Gemini 3.5 Flash to produce a bounded search plan.
4. Execute only allowed LangChain tools from that plan.
5. Discover Apify MCP tools for agent context and future tool expansion.
6. For company searches, run the LinkedIn Company Employees actor first.
7. Use RAG Web Browser for location, role, school, and open-ended searches.
8. Run Apify only on cache misses or forced refresh.
9. Normalize profiles.
10. Ask Gemini to strictly validate/rerank candidates when a Gemini key is configured.
11. Save contacts, evidence, leads, and notes.

This keeps the app agentic without making it reckless. Gemini decides the search strategy, LangGraph controls the workflow, and LangChain tools execute only approved actions with caching, tool limits, cost control, dedupe, and hard filters.

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

## Next Steps

- Add ScaleKit auth and partition saved leads by user.
- Add a dedicated LinkedIn Apify Actor once you choose the exact actor and input schema.
- Add LLM extraction for richer profile parsing from long Apify text results.
