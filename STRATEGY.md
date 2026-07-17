# Find Your Armenian — Strategy: making discovery "better"

Decision-ready plan for going beyond LinkedIn-only discovery, tightening precision
(e.g. real VPs, not headline-substring VPs), and building a durable local Armenian
database — all on a ~$5/mo Apify plan.

**Grounding note (verified against the repo, 2026-07-07):**
- Current bench baseline (`bench/baseline.json`): **composite 89/100**, detector
  **F1 1.0** on a **40-name** labeled set (`bench/labels-names.json`).
  Pipeline: `openai-company` recall 0.50 / nameP 0.75 / companyMatch 1.0;
  `sf-ai-founders` recall 0.857 / nameP 1.0.
- Durable store today: **5 contacts** (`data/contacts.json`), **20 profiles**, **13
  cached Apify runs** (`data/raw-runs/`). The "local DB" is real but tiny.
- Composite weights (`bench/run.mjs:112`): `0.35*detectorF1 + 0.25*recall +
  0.25*precision + 0.15*companyMatch`. Recall + precision together are **half** the
  score, so recall is where the headroom is (detector F1 is already maxed on the
  current 40-name set — see the honesty note in §3.5).
- The bench runs **fast mode with Gemini OFF** (`bench/run.mjs:29-31`). Anything that
  only touches the Gemini planner will **not** move the bench unless it also lands in
  the deterministic path (`parseIntent` → `profileSearchInput`). This constrains how
  we sequence the "LLM does VP seniority" work (see §3.3).

---

## 1. TL;DR — the highest-leverage moves

1. **Surname-seed LinkedIn itself.** Push the tiered surname model into harvestapi's
   `lastNames[]` filter (ANDed with company/location), instead of only the
   `searchQuery:'Armenian'` string. Finds Armenians who never write "Armenian" — the
   single biggest recall win, $0 beyond pages already spent.
2. **Add GitHub as a free second source.** Direct GitHub API (free PAT) gives
   name + company + location + bio for engineers/founders LinkedIn misses, scored by
   the *same* surname model. This is the concrete answer to "other sources."
3. **Make the local roster a cache, not a log.** Query `contacts.json` *before* any
   paid actor and only pay for the gap. On the $5 plan every fully-local repeat search
   saves ~$0.10–0.14. Add a `local-hit-rate` + `est-cost-saved` metric to the bench.
4. **Let the LLM emit real seniority/function filters, not title strings.** "VP of
   sales" → `seniorityLevelIds` + `functionIds`, not `headline LIKE '%sales%'`. Pure
   precision at no extra Apify cost.

---

## 2. Prioritized moves

| # | Move | What | Impact | Effort | Cost | Bench metric it should move |
|---|------|------|:------:|:------:|------|------------------------------|
| 1 | **Surname-seeded `lastNames[]` discovery** | Run a 2nd harvestapi variant with a ranked ~120-name surname seed instead of `searchQuery:'Armenian'`; dedupe | High | Med | $0.10/page (same billing) | `knownRecall` ↑ on both golden queries (0.50→↑, 0.857→↑); nameP stays ~1.0 |
| 2 | **GitHub discovery adapter** | New source: users by `location:Armenia`/`Yerevan` + org members of anchor firms + surname seed; enrich; score | High | Med | $0 (free PAT) | Net-new recall not present via LinkedIn; composite ↑ at ~$0 |
| 3 | **Local-first roster lookup** | Serve verified roster before paid actors; only pay for `limit − localHits` | High (cost) | Med | Negative marginal | New `localHitRate` / `estCostSaved`; `paidActorCalls`→0 on repeat query |
| 4 | **LLM → structured seniority/function filters** | "VP"/"founder"/"CTO" → `seniorityLevelIds`/`functionIds`, not substrings | High | Low | $0 (filters don't change Short billing) | `precisionByName` + `companyMatchRate` hold while off-title records drop |
| 5 | **Local onomastics DB + surname flywheel** | Frequency-weighted surname/given-name lexicon from free datasets; learned surnames feed detector + seed queries | Med-High | Low-Med | ≈€55 one-time + free | Detector F1 held as labeled set hardens; recall ↑ from richer seeds |
| 6 | **Resolve company → LinkedIn company URL** | Use the already-configured company-search actor so `currentCompanies` binds to the real entity | Med | Low | 1 cheap cached page/company | `companyMatchRate` holds at 1.0 while recall improves |
| 7 | SERP-expansion (X, blogs, speaker pages) | Reuse rag-web-browser with source-specific dorks | Med | Low | fractions of a cent | net-new recall from non-LinkedIn hosts |
| 8 | OpenAlex + ORCID researcher channel | Free academic discovery, Armenia-affiliation + surname | Med | Low | $0 | net-new researcher recall |
| 9 | YC directory company→founder funnel | Free JSON → founders via SERP/scrape | Med | Med | free JSON + cheap scrape | net-new founder recall |
| 10 | NamSor tiebreaker for the uncertainty band | 2nd onomastics opinion only on borderline `-ian` names | Med | Low | free ≤250/mo, then ~$0.05/name | precision on the disambiguation subset |
| 11 | Deprioritize paid Crunchbase/X APIs | Do **not** subscribe; SERP covers X, YC+GitHub cover companies | Low | Low | $0 saved | confirm no recall/precision cost vs free stack |

---

## 3. Top 6 moves — implementation notes + measurable hypothesis

### 3.1 Surname-seeded discovery via `lastNames[]` (biggest recall win)

**Why.** Today `profileSearchInput` (`src/apifyClient.js:57-69`) sets
`searchQuery: intent.wantsArmenian ? 'Armenian' : …`. That can only reach people who
literally write "Armenian" somewhere. The golden lists prove the gap: `sf-ai-founders`
includes non-self-labelers like `bdoyan`/`atarbekyan` (recall 0.857), and
`openai-company` sits at recall **0.50**. The surname model is already excellent
(`armenianSurnameScore`, `src/people.js:588-623`) — but it only runs *after* download,
as a ranker. Pushing it into LinkedIn's index as a *filter* is the lever.

**How.**
- Expand `ARMENIAN_SURNAME_QUERY_BATCH` (`src/people.js:60-63`, currently 12 names used
  only for Google OR-queries) into a ranked seed of ~120–150, warm-started from
  `COMMON_ARMENIAN_SURNAMES` (`src/people.js:18-28`, ~60 names) + Forebears top
  surnames. Keep Eastern `-yan` and diaspora `-ian` as separate tiers.
- In `profileSearchInput`, when `intent.wantsArmenian`, build a **second input variant**
  with `input.lastNames = seed` (drop `searchQuery`) alongside the keyword variant.
  Run both, dedupe by `identityKey` in `dedupeByIdentity` (`src/discovery.js:122`).
- **Batching / cost:** with a company or location AND-anchor, each surname returns few
  hits, so one array + `takePages` sweeps cheaply (enumerate Armenians at a 5k-person
  company ≈ seed `lastNames` + `currentCompanies`, ~4 pages ≈ **$0.40**). For an
  open/location sweep with no anchor, partition into batches of ~15 to stay under
  LinkedIn's 1000-result cap (~$0.10 per 15-name page).
- **Honesty / de-risk:** the OR-semantics and page arithmetic of `lastNames[]` are not
  verified from here — run one **$0.10 probe page** first to confirm behavior before
  locking batch size. The task confirms `lastNames`/`seniorityLevelIds` exist on the
  actor; treat `functionIds`/segmentation as "verify with the probe."

**Hypothesis (bench):** add surname-seeded fixtures via `--capture`; expect
`openai-company` `knownRecall` 0.50 → ~0.8+ and `sf-ai-founders` 0.857 → ~1.0.
`precisionByName` stays ~1.0 (every seeded hit scores >0 on the name model; Persian
`-ian` downgrade in `armenianSurnameScore:600-621` guards false positives). Detector
F1 unchanged (name model untouched). Composite ↑ via the 0.25 recall weight.

### 3.2 GitHub discovery adapter (free, non-LinkedIn source)

**Why.** GitHub is the best free non-LinkedIn tech source: it exposes name, company,
blog, twitter, email, bio, location and repo languages, and the same surname scorer
applies to real names *and* logins. It adds a tech-role signal LinkedIn lacks
(repos/org membership/contribution graph).

**How.** New adapter mirroring the harvestapi adapter shape in `src/apifyClient.js`:
- Discovery: `GET https://api.github.com/search/users?q=location:Yerevan+location:Armenia`
  (paginate to the 1000 cap; add diaspora-city queries) **plus**
  `GET /orgs/{org}/members` for anchor firms (Picsart, Krisp, SoloLearn, Renderforest,
  ServiceTitan). Warm-start free from `gayanvoice/top-github-users` `armenia.md`
  (~955 users with name+company already in the table).
- Enrich: batch via GraphQL (~100 logins/query for name/company/location/bio/website/
  twitter) to stay inside 5,000 points/hr; REST `GET /users/{login}` fallback
  (5,000/hr). Respect the 30 req/min Search cap with a limiter.
- Score: feed `name + login + bio` through `normalizeCandidates` /
  `scoreCandidate` (`src/people.js:148,267`) with `source='github'`; add repo-language
  / org-membership as new context features.
- **Determinism for bench:** cache GitHub responses into `data/raw-runs/` exactly like
  Apify runs (`saveRawRun`/`getRawRun`, `src/store.js:74-94`) so golden queries stay
  reproducible and free.

**Honesty.** `location:Armenia` is high-precision but **low-recall** (~955 tracked
users vs 20k+ devs; diaspora list SF/LA). The recall lever here is still the surname
suffix, not location. Expect **modest net-new volume** but at literally $0 and with an
independent corroboration signal (see cross-verification in §5/§6).

**Hypothesis (bench):** add a GitHub arm to the golden runs; measure unique Armenian
contacts found on GitHub **not** present via LinkedIn (net-new recall) and precision on
that channel. Composite rises from added recall at ~zero cost.

### 3.3 LLM intent → structured seniority/function filters ("VP done right")

**Why.** The user explicitly wants precise "VP" seniority. Today role → titles is a
static map (`targetTitlesForRole`, `src/apifyClient.js:179-191`) and the only server-
side facets used are `currentJobTitles`/`locations`/`currentCompanies`. Seniority and
function are **server-side facets** on the actor — "VP of sales" should become
`currentJobTitles:['VP Sales','Vice President Sales','Head of Sales']` +
`seniorityLevelIds:['300']` + `functionIds:['25']`, not "everyone whose headline
contains 'sales'." "founders" → `seniorityLevelIds:['320']` (Owner/Partner) +
`functionIds:['9']`; "CTO" → `['310']`; "director of engineering" → `['220']` +
`functionIds:['8']`.

**How.**
- Add a `harvestFilters` block to `requestSearchPlan`'s JSON output
  (`src/geminiClient.js:176-213`); inject the verified seniority/function ID tables into
  the prompt as an **enum whitelist** so Gemini emits IDs directly.
- Add a deterministic validator in `sanitizePlan` (`src/geminiClient.js:402`) that drops
  any ID not in the whitelist and de-dupes titles (mirror the existing
  `sanitizeSearchQuery` guard).
- Thread the block into `profileSearchInput` (`src/apifyClient.js:57`) as
  `seniorityLevelIds`/`functionIds`/`industryIds` arrays. Keep the static
  `targetTitlesForRole` map as the offline fallback when Gemini is off.

**Honesty / sequencing.** The **bench runs Gemini OFF in fast mode**
(`bench/run.mjs:30`, `src/fastAgent.js` uses `parseIntent` directly and never calls the
planner). So to make this *measurable* you must also let `parseIntent` emit a coarse
seniority hint (regex "VP|vice president|head of|director|founder|cto") into `intent`,
and have `profileSearchInput` map it to IDs deterministically — otherwise the improvement
only shows up in the (nondeterministic, Gemini-on) agent path and never on the bench.
Filters do **not** change Short-mode billing ($0.10/page regardless of filter count).

**Hypothesis (bench):** re-capture golden queries; expect `sf-ai-founders`
`precisionByName` to hold ~1.0 while `resultCount` stays qualified, and `openai-company`
`companyMatchRate` to stay 1.0 with fewer off-title records. Detector F1 unchanged.

### 3.4 Local-first lookup — pay only for the gap

**Why.** The infrastructure exists but is **underused**. `searchContacts` +
`contactCacheScore` + `hasVerifiedContactCompanyEvidence` (`src/store.js:104-124,
257-302`) can already rank stored contacts against an intent with a verified-company
gate. But `langchainAgent.checkContactCache` (`src/langchainAgent.js:115-130`) folds
hits in **additively** — `discoverCandidatesNode` (132-141) still runs the full paid
pipeline every time — and `fastAgent` (`src/fastAgent.js`) never consults the DB at all.
So "hit local DB first, pay only for gaps" is **not implemented**. On the $5 plan
(~50 harvest pages **or** ~800 enrichments/mo) every local hit is a direct credit saving.

**How.**
- Add `resolveLocal(intent, limit)` to `store.js`: reuse `contactCacheScore` + the
  `hasVerifiedContactCompanyEvidence` gate to return ranked verified/probable hits plus
  `need = limit − hits.length`, with a freshness check on `lastSeenAt` (re-verify if
  > 30d).
- In `searchPeopleFast` (`src/fastAgent.js:7`) and `discoverCandidatesNode`, short-
  circuit when `need <= 0`; otherwise call `discoverCandidates` with `limit = need` so
  the shrunken limit flows into `profileSearchInput`/`inputForActor` (which already clamp
  `maxItems`).
- Persist results back through the existing upsert flow, bumping
  `timesMatched`/`lastSeenAt` so hot queries stay warm.

**Hypothesis (bench):** new `localHitRate = localServed/requested` per golden query
(§6). Target: rises from ~0 toward >0.6 as the roster fills; `paidActorCalls` hits 0 on
the **second** run of the same intent. Keep quality metrics unchanged (scoring path is
identical) — only cost drops.

### 3.5 Local onomastics DB + surname flywheel

**Why.** The lexicon is hardcoded: `COMMON_ARMENIAN_SURNAMES` (~60),
`ARMENIAN_FIRST_NAMES` (~70, already a **+12 weak** signal at `src/people.js:311-314`),
`ARMENIAN_SURNAME_QUERY_BATCH` (12). There's no feedback from finds. A real, frequency-
weighted lexicon generalizes the detector beyond curated entries and directly enriches
the surname-seed queries in §3.1.

**How.**
- Build `data/armenian_lexicon.json` from free/cheap datasets: extract the **AM slice**
  of `philipperemy/name-dataset` (free bulk surnames+given names+gender); layer
  `census.name` Armenian DB (352 surnames + 1,901 given names *with frequency*, €55,
  JSON); add Wiktionary given names (free, CC-BY-SA); use Forebears incidence
  (headless-browser scrape) for top-surname priors. Encode the ASL suffix findings
  (77% `-yan/-yans/-yants` = tier-1; `-ian` with Persian/Russian disambiguation;
  Russified `-ov/-ova` ≈2% weak) as rules — this **confirms the existing model**.
- Load the lexicon at module init and UNION it into `COMMON_ARMENIAN_SURNAMES` so
  `armenianSurnameScore`/`armenianNameScore` (`src/people.js:588-642`) score learned
  names as strong, and rebuild `ARMENIAN_SURNAME_QUERY_BATCH` from top-frequency entries.
- **Flywheel:** `store.js recordSurname(surname,{tier,suffix,source})` increments a
  counter; `promoteSurnames()` moves a surname into the curated tier once ≥3 independent
  verified people carry it AND it passes the existing Persian/Chinese/Western guards
  (`src/people.js:597-621`). The bench detector is the regression gate against drift.

**Honesty.** The current detector F1 is **1.0 on a 40-name set** — you cannot improve
past that on today's labels. The real value is (a) **recall** in discovery via richer
seeds, and (b) hardening F1 as you **grow the labeled set with hard cases** (Persian
`-ian`, Chinese pinyin `-yan`, Westernized/married surnames, given-name-only hits). So
pair the lexicon work with expanding `bench/labels-names.json` — otherwise the bench
will show "no change" and understate the win.

**Hypothesis (bench):** with an expanded labeled set, detector F1 holds/rises without a
precision drop on the disambiguation labels; pipeline `knownRecall` rises as the seed
batch grows. `--gate` fails CI if composite drops.

### 3.6 Resolve company name → LinkedIn company URL (precision prerequisite)

**Why.** `currentCompanies` is documented to expect full LinkedIn company URLs, but the
code passes a **plain string** (`src/apifyClient.js:63`, `input.currentCompanies =
[intent.company]`). Binding to the real company entity tightens company-match and is a
prerequisite for reliable surname-seeded *company* enumeration (§3.1).

**How.** Wire the already-configured `config.apifyCompanySearchActor`
(`src/config.js:46`, `harvestapi/linkedin-company-search` — the planner's guarded
`company_search` tool, `src/geminiClient.js:22-25`) to resolve `intent.company` → company
URL, cache it in the store, pass the URL into `currentCompanies`. Fall back to the plain
string on resolution failure.

**Hypothesis (bench):** `companyMatchRate` (0.15 weight) holds at 1.0 on
`openai-company` while `resultCount`/recall improve because the filter binds to the real
entity rather than a fuzzy string. One extra cheap company-search page per distinct
company, cached thereafter.

---

## 4. Quick wins (<1 hr each) vs bigger bets

**Quick wins (do first):**
- **Expand `ARMENIAN_SURNAME_QUERY_BATCH`** (`src/people.js:60`) from 12 → ~120 names
  seeded from `COMMON_ARMENIAN_SURNAMES` + Forebears. Immediately improves the existing
  Google OR-batch recall for open/location searches — no new integration.
- **`$0.10 probe` of harvestapi `lastNames[]`** to confirm OR-semantics before building
  §3.1's batching.
- **Add the `localHitRate` / `estCostSaved` counters to `bench/run.mjs`** (§6) — pure
  instrumentation, no behavior change, makes the cost story measurable.
- **Wire the guarded `company_search` actor** into `currentCompanies` (§3.6) — small,
  self-contained.
- **Warm-start the roster** by parsing `gayanvoice/top-github-users` `armenia.md`
  (955 rows, name+company+login) into `contacts.json` via the existing upsert flow.
- **Grow `bench/labels-names.json`** beyond 40 with hard disambiguation cases so the
  detector metric has room to prove the lexicon work.

**Bigger bets (multi-hour, sequence after quick wins):**
- Full GitHub adapter with GraphQL enrichment + org-member crawl + raw-run caching (§3.2).
- Surname-seeded second harvestapi variant + dedupe wiring (§3.1).
- Local-first short-circuit across both `fastAgent` and `langchainAgent` + roster schema
  migration (§3.4, §6).
- Frequency-weighted lexicon build + promotion flywheel (§3.5).
- Seniority/function ID planner + deterministic parse hint (§3.3).
- Yield-gated iterative fan-out controller generalizing the thin-result gate at
  `src/discovery.js:49` (adaptive page-buying with a marginal-yield stop).

---

## 5. Data sources beyond LinkedIn — ranked (access method + cost)

Ranked by value-for-effort for a tech search on the $5/mo budget. All are free or
one-time cheap; the dominant Armenian signal across all of them remains the surname
suffix already modeled.

1. **GitHub — top pick, $0.** Direct REST/GraphQL with a free PAT.
   `search/users?q=location:Armenia` + `/orgs/{org}/members` for anchor firms; two-step
   (search → `/users/{login}`). Warm-start from `gayanvoice/top-github-users`
   `armenia.md`. Adds a tech-role signal LinkedIn lacks. Low recall on location alone —
   surname suffix is the lever. (No-code fallback: Apify `khadinakbar/github-deep-scraper`
   $0.005/record — not needed.)
2. **rag-web-browser SERP expansion — near-free (already budgeted).** Templated dorks
   cover X/Twitter (`site:x.com "-yan" <role>`), personal sites/blogs, and conference
   speaker pages (devfest.am, yerevantechforum.am, Silicon Mountains, EMERGE, enumerated
   via dev.events/AS/AM/Yerevan). This is why you can **skip** the paid X API
   ($100–5,000/mo) entirely. Parse handles from snippets, dedupe, route through existing
   enrichment + scorer.
3. **OpenAlex + ORCID — $0, researcher channel.** `api.openalex.org/authors?filter=
   last_known_institutions.country_code:AM` (no key; append `&mailto=` for the polite
   pool) + `pub.orcid.org/v3.0/{orcid}/employments` for current employer. Strictly
   cheaper than SerpApi Google Scholar ($75/mo). Institution-country is a near-
   deterministic context boost.
4. **YC directory — free JSON funnel.** `yc-oss.github.io/api/companies/all.json` (6,001
   companies, daily). No founder names in the feed → filter regions/locations for
   Armenia, then resolve founders via the public company page or SERP, then score. Cache
   with the existing TTL.
5. **Curated Armenian-affinity seed lists — highest precision (membership = the label).**
   HIVE Ventures portfolio (explicitly Armenian-founder-only — the single best pre-
   verified list), SmartGateVC/Formula/Granatus portfolios, `startupblink.com/top-
   startups/armenia`, `staff.am` company directory (seed for `currentCompanies`), and
   **public** AESA/Homenetmen/AGBU board/chapter/event/awardee pages (member directories
   themselves are gated). TUMO alumni via Alumnifire.
6. **Onomastics datasets (seed the local DB, §3.5):** `philipperemy/name-dataset` AM
   slice (free bulk), `census.name` Armenian DB (€55, frequency-weighted),
   Wiktionary given names (free), Forebears incidence (headless scrape). NamSor origin
   API as a paid tiebreaker only (free ≤250 name-origins/mo, then ~$0.05/name).
7. **Deprioritize: direct Crunchbase / X APIs.** Crunchbase killed its free tier
   ($49–99/mo self-serve); X search is $100–5,000/mo. Neither adds Armenian-specific
   signal over GitHub+YC+SERP. If company funding is ever needed, use Apify
   `curious_coder/crunchbase-scraper` (~$0.73/1k) on-demand behind a flag — not a
   subscription.

**Cross-verification (raises confidence, not just recall):** a LinkedIn surname hit that
*also* has a GitHub account with `location:Yerevan` is high-confidence. Feed "≥2
independent sources agree" as a signal to `scoreCandidate` (`src/people.js:267`) and to
the Gemini rubric (`src/geminiClient.js:124`) so weak single-source `-ian` names don't
get promoted.

---

## 6. The local Armenian DB flywheel

**Goal.** Turn `contacts.json` from a durable log into a first-class, ever-growing
"all-Armenian" roster that (a) is served *before* any paid actor and (b) feeds its own
surname lexicon back into detection and discovery.

### 6.1 Schema (extends the current `contacts.json` record; `+` = new)

`identityKey` stays the primary key (`src/people.js:505-508`).

```jsonc
{
  "id": "person_<hash(identityKey)>",
  "identityKey": "linkedin.com/in/hrachyahakobyan",   // primary key (unchanged)
  "name": "Hrachya Hakobyan",
  "aliases": ["Hrachya Hakobyan", "H. Hakobyan"],      // mergeStrings (unchanged)
+ "identifiers": { "linkedin": "hrachyahakobyan", "github": "hhakob",
+                  "wikidata": "Q...", "email": null, "twitter": null },
  "company": "OpenAI", "role": "engineer", "location": "",
  "profileUrl": "https://www.linkedin.com/in/hrachyahakobyan",
+ "ethnicity": { "status": "verified",     // verified | probable | candidate | rejected
+                "method": "llm",           // llm | name-model | source-declared | manual
+                "score": 92, "verifiedAt": "...", "verifiedBy": "gemini-3.5-flash" },
+ "surnameSignal": { "surname": "hakobyan", "suffix": "yan", "tier": 30 },  // feeds flywheel
  "sources": [ { "url": "...", "title": "...", "snippet": "...", "context": "...",
                 "query": "...", "actorId": "...", "affiliationVerified": true,
+                "sourceKind": "linkedin-serp",  // github | wikidata | openalex | forebears-seed | prior-search | manual
+                "license": "CC0", "retrievedAt": "..." } ],
  "evidence": [ { "type": "name|source|company|gemini", "text": "..." } ],
  "confidence": 92, "confidenceLabel": "strong",
+ "firstSeenAt": "...", "lastSeenAt": "...", "timesMatched": 3,   // freshness + demand
+ "mergedIds": ["person_oldkey"],                                 // audit of merges
  "createdAt": "...", "updatedAt": "..."
}
```

**Identity-resolution cascade** (generalizes the `byKey` Map in
`upsertContactsFromProfilesLocked`, `src/store.js:159-198`): match on first available
strong key — (1) LinkedIn slug → (2) github login → (3) wikidata QID → (4)
name+company → (5) name-surname+location. On a hit, merge via the existing
`mergeByUrl`/`mergeEvidence`/`mergeStrings` helpers, `Math.max(confidence)`, keep earliest
`createdAt`, push the absorbed id into `mergedIds`. Only `status ∈ {verified, probable}`
records join the served roster; `{candidate, rejected}` stay quarantined so precision is
protected.

### 6.2 Growth loop

```
   ┌─ seed (one-time, free) ─────────────────────────────────────┐
   │  Wikidata SPARQL (P172=Q79797 Armenians → P6634 LinkedIn,    │
   │  P2037 GitHub, P108 employer)                                │
   │  GitHub search (location:Armenia) + top-github-users md      │
   │  backfill existing profiles.json / contacts.json             │
   └──────────────────────────────┬──────────────────────────────┘
                                   ▼
   every search ──► resolveLocal(intent) ──► need = limit − localHits
                                   │                    │
                    (need<=0) done │       (need>0) pay only for the gap
                                   ▼                    ▼
                        serve from roster       discover (harvest+github+web)
                                                        │
                                   ┌────────────────────┘
                                   ▼
              upsert verified people ──► recordSurname() ──► promoteSurnames()
                                   │                              │
                                   ▼                              ▼
                        contacts.json grows        lexicon.json grows ──► richer
                        (timesMatched++)            lastNames[] seed + detector
                                   └──────────── compounding recall ◄──────────┘
```

Each verified Armenian's surname (`surnameSignal`) feeds `recordSurname`; once a surname
clears the promotion threshold (§3.5) it strengthens both the detector and the
`lastNames[]`/OR-batch seeds — so detection and discovery **compound** as the DB grows,
at $0 marginal cost.

### 6.3 New bench metrics (`bench/run.mjs`)

Instrument `evalPipeline` (`bench/run.mjs:63-101`) — the run summaries already carry
`actorId`/`cached` — to count `localServed` vs `paidActorCalls` per query, then:

- `localHitRate = localServed / requested`
- `estCostSaved = avoidedHarvestPages*0.10 + avoidedEnrichments*0.006` (real costs from
  `src/config.js`)
- `coverage` = distinct `verified` roster records (trend line)

Print these next to `COMPOSITE` and add them to the snapshot (`bench/run.mjs:157-168`).
Keep `localHitRate` **out** of the composite initially so it doesn't mask quality; fold a
small term in only once the roster is warm. Add a unit fixture asserting identity-merge
correctness (same person from 3 `sourceKind`s → 1 record, N `mergedIds`).

**Success criteria:** `localHitRate` climbs from ~0 toward >0.6 after seeding + a few
searches; running the same golden query twice shows `paidActorCalls` → 0 on the second
run; composite stays ≥ 89 (no quality regression).

---

## 7. Honest cost picture on the $5/mo plan

- Budget ≈ **50 harvest pages** *or* **~800 enrichments/mo** ($0.10/page Short mode;
  $0.006/profile enrichment, capped at 6/search ≈ $0.036).
- Surname-seed (§3.1) does **not** raise per-page cost — it changes *which* people fill
  the page, so precision-per-dollar rises. Enumerating a big roster the naive way
  (broad roster + local filter) would blow the budget and hit the 1000-cap; the
  surname-seed gives the same recall **without paying for discarded non-Armenians** —
  reserve broad-roster only for ≤200-person targets.
- GitHub, OpenAlex, YC JSON, Wikidata, SERP dorks, and the local roster are all **$0 or
  fractions of a cent**, so the roadmap adds *sources and recall* while pushing average
  cost/qualified-contact **down**, not up.
- The one-time spends worth making: **€55** for the frequency-weighted `census.name`
  lexicon; everything else is free-tier.
