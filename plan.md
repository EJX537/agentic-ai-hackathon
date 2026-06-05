# Web Research Agent — Architecture Plan

## Overview

An iMessage-connected agent that researches the web on your behalf. Send a query with text + images, and the agent searches indexed pages (Tavily/SearXNG) and live JS-heavy pages (AX + Puppeteer), remembers what it learns organized by category, and replies with curated results.

---

## 1. Data Flow

### Phase 0: Current (As-Built)

```
iMessage ──→ Spectrum ──→ Orchestrator ──→ RocketRide (injest.pipe)
                                             │
                                    ┌────────┴──────────────┐
                                    │ LLM (Butterbase AI)   │
                                    │   + XTrace tools      │ ← recall/remember
                                    │   + Butterbase MCP    │ ← DB/Auth/docs
                                    │   + Internal memory   │
                                    └────────┬──────────────┘
                                             │ result
                                             ▼
                                    Orchestrator
                                    ┌────────┴──────────────┐
                                    │ Custom agent logic    │ ← search, scrape, browse
                                    │   + XTrace ingest     │ ← store findings
                                    │   + Butterbase save   │ ← persist
                                    └────────┬──────────────┘
                                             │
                                             ▼
                                        Spectrum ──→ iMessage
```

The pipeline (injest.pipe) does **pre-work** before the custom agent runs:
- Recalls XTrace memories to ground the response
- Uses Butterbase AI Gateway for LLM reasoning
- Stores/retrieves data via Butterbase MCP tools
- Returns the LLM's analysis to the orchestrator

The orchestrator then runs the **custom agent logic** (search, scrape, browse) and may loop results back through the pipeline.

**Key shift from original plan:** XTrace recall/ingest and Butterbase DB operations are now handled **inside the pipeline** via tool nodes, not just in TypeScript. The orchestrator still owns search/scrape/browse and the final reply.

---

## 2. Component Breakdown

### 2a. RocketRide Pipeline (`pipelines/injest.pipe`)

The pipeline now serves as the **LLM reasoning + memory + database** layer. Components:

| Node | Role |
|---|---|
| **Chat Source** | Entry point — receives the user query from the orchestrator via `send()` |
| **RocketRide Wave Agent** | Orchestrates tool calls — decides when to recall, remember, query DB |
| **LLM (Butterbase AI Gateway)** | LLM provider — `google/gemini-3.5-flash` via `llm_openai_api` |
| **Memory (Internal)** | Short-term scratchpad for the current run |
| **XTrace Memory** | Long-term shared memory — `xtrace.recall` / `xtrace.remember` |
| **Butterbase MCP** | Database CRUD, auth, schema, docs via tool calls |
| **Return Answers** | Sends the pipeline result back to the orchestrator |

The orchestrator passes the query via `rocketride.send()`. The pipeline processes it through the LLM agent (which can call XTrace and Butterbase tools), and returns the final LLM answer.

### 2b. Custom Agent Logic (in `orchestrator.ts`)

After the pipeline returns, the orchestrator executes the web research tools:

| Step | Tool | Purpose |
|---|---|---|
| Web search (indexed) | Tavily AI API or SearXNG | Find relevant pages for the query |
| Page extraction | Trafilatura | Extract clean text from indexed pages |
| Live browsing | Puppeteer + AX | Navigate JS-heavy pages, fill forms, click, scrape |
| Classify/categorize | Butterbase AI Gateway or mock | Group results by category |
| Content memory | XTrace `ingest()` | Store page content grouped by category |
| State persistence | Butterbase DB | Save sessions, results, cache |

### 2c. Memory Architecture (XTrace)

Websites are ingested into XTrace organized by **group**, where each group is a content category:

```
Groups:  "food", "travel", "tech", "shopping", "news", ...
```

The pipeline uses `xtrace.recall` at the start of each turn to ground responses. After the custom agent runs, the orchestrator ingests findings via `xtrace.ingest({ group_ids: [...] })`.

### 2d. Browser Automation (Puppeteer + AX)

For sites that need JS execution (dynamic content, forms, login walls):

| Action | Tool |
|---|---|
| Navigate to URL | Puppeteer `page.goto()` |
| Extract text | `page.evaluate(() => document.body.innerText)` |
| Scan interactive elements | AX `scan()` → discover buttons, inputs, forms |
| Click/fill/submit | AX `invoke()` on discovered elements |
| Screenshot (for vision) | Puppeteer `page.screenshot()` → base64 → pass to LLM |

### 2e. Web Search (Indexed)

| Tool | Use |
|---|---|
| **Tavily AI** | API-key based, returns search results + extracted content. Good for quick lookups. |
| **SearXNG** | Self-hosted metasearch. No API key needed. Returns results from multiple engines. |
| **Trafilatura** | Python-based (or via shell) page content extraction. Strips ads/nav/boilerplate. |

Decision: use Tavily as primary (simpler), fall back to SearXNG for uncensored/deep web results.

### 2f. Butterbase

Mandatory: database, auth, AI model gateway.

| Feature | Usage |
|---|---|
| **Database** (MCP tool) | Via pipeline's Butterbase MCP tool — `butterbase.*` tools for CRUD, schema, RLS |
| **Auth** (MCP tool) | Via pipeline's Butterbase MCP tool — `butterbase.auth_*` tools |
| **AI Model Gateway** (LLM node) | Primary LLM for the pipeline — `llm_openai_api` pointing at `https://api.butterbase.ai/v1` |
| **Classification** (TypeScript SDK) | Fallback: `client.ai.chat()` for categorizing search results in the orchestrator |

**Schema sketch:**
```sql
-- search_sessions: one per iMessage query
sessions (id, user_id, query_text, image_refs, created_at)

-- search_results: individual pages discovered
results (id, session_id, url, title, snippet, category, visited_at)

-- website_cache: extracted content per URL (avoid re-scraping)
cache (url, title, content, category_group, ax_actions, cached_at)
```

### 2g. Spectrum → iMessage

Already wired. Spectrum handles the platform adapters. The orchestrator's `listen()` callback receives iMessage events and sends replies.

---

## 3. Pipeline Integration Detail

The orchestrator passes data to the pipeline and handles the result:

```ts
// 1. Send to pipeline
const result = await rocketride.send({
  text: userQuery,
  context: {
    userId,
    conversationId,
  },
});

// 2. Pipeline returns LLM-processed answer
//    (pipeline internally recalled XTrace, used Butterbase, etc.)

// 3. Custom agent logic runs
const searchResults = await searchTool.search(userQuery);
const scraped = await scrapeTool.extract(searchResults);
// ... browse, classify, etc.

// 4. Ingest findings into XTrace (by group)
await memory.ingest([...findings], { group_ids });

// 5. Persist to Butterbase
await butterbase.insertSession({ ... });

// 6. Reply
await spectrum.send({ conversationId, text: finalAnswer });
```

---

## 4. Implementation Order

### Phase 0 (DONE): Foundation & mandatory requirements

| Step | Status |
|---|---|
| Project init (Bun + TypeScript) | ✅ |
| RocketRide core pipeline (injest.pipe) | ✅ — LLM + XTrace + Butterbase MCP tools |
| Butterbase DB + Auth + AI Gateway | ✅ — pipeline MCP + SDK client |
| XTrace memory groups | ✅ — group registration, tagged ingest |
| Spectrum messaging | ✅ — send/receive wired |
| Integration tests | ✅ — full flow passes |
| Puppeteer + AX browser automation | ✅ — BrowserAgent ready |
| Mock search/scrape tools | ✅ — placeholder for Phase 1 |

### Phase 1: Real search & content extraction

```
  └─ Tavily AI API integration (search tool)
  └─ SearXNG fallback (search tool)
  └─ Trafilatura content extraction (scrape tool)
  └─ Wire real tools into orchestrator's custom agent logic
  └─ Test: "Find me X" → search → return results via iMessage
```

### Phase 2: Live browsing (Puppeteer + AX)

```
  └─ Agent decides when to browse (not just search)
  └─ AX scan → action loop for interactive pages
  └─ Screenshots for vision-based analysis
  └─ Test: "Check prices on this dynamic site"
```

### Phase 3: Full memory loop with categorization

```
  └─ Recall before search (pipeline handles this)
  └─ Classify results into groups (food, travel, tech, ...)
  └─ Ingest findings by group (orchestrator handles after pipeline)
  └─ Test: same query twice → pipeline recalls cached knowledge
```

### Phase 4: Polish & pipeline tuning

```
  └─ Pipeline topology refinement
  └─ Image input handling (iMessage attachments → base64 → LLM)
  └─ Error handling, rate limiting, retries
  └─ End-to-end smoke test
```

---

## 5. File Map

| File | Status | Change |
|---|---|---|
| `src/tools/search.ts` | 📝 Mock | **Phase 1** — Replace with Tavily/SearXNG client |
| `src/tools/scrape.ts` | 📝 Mock | **Phase 1** — Replace with Trafilatura |
| `src/tools/classify.ts` | 📝 Mock | **Phase 3** — Replace with Butterbase AI gateway |
| `src/memory/xtrace-memory.ts` | ✅ Done | Memory service with group support |
| `src/agents/orchestrator.ts` | ✅ Done | Full flow: pipeline → custom agent → memory → DB → reply |
| `src/backend/butterbase.ts` | ✅ Done | Typed DB client, auth, AI gateway methods |
| `pipelines/injest.pipe` | ✅ Done | LLM + XTrace tools + Butterbase MCP (managed in pipeline builder UI) |
| `src/browser/puppeteer.ts` | ✅ Done | BrowserController with AX bridge |
| `src/browser/browser-agent.ts` | ✅ Done | High-level browser agent |
| `src/dom/ax-interface.ts` | ✅ Done | AX dom interface |
| `src/config/env.ts` | ✅ Done | Environment config |
| `src/index.ts` | ✅ Done | Entry point with graceful shutdown |
| `tests/integration.test.ts` | ✅ Done | Full pipeline tests |

---

## 6. Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Pipeline role | **Pre-work** (memory recall + LLM reasoning + DB ops) | Pipeline has XTrace and Butterbase tools built in. Let it handle what it can before the TS layer runs. |
| LLM provider | **Butterbase AI Gateway** (OpenAI-compatible via `llm_openai_api`) | Meets mandatory requirement. Model: `google/gemini-3.5-flash`. |
| Search API | Tavily (primary), SearXNG (fallback) | Tavily gives extracted content + results in one call. SearXNG for uncensored results. |
| Content extraction | Trafilatura (Python, call via `exec`/subprocess) | Best-in-class boilerplate removal. Falls back to Puppeteer text extract for JS pages. |
| Page interaction | Puppeteer + AX | Already have it. AX discovers actions, Puppeteer executes them. |
| Memory grouping | XTrace `group_ids` | Native XTrace feature. Each category is a group. |
| Pipeline config | **Pipeline builder UI only** | Do not edit `.pipe` files directly — UI manages the JSON structure. |
| Image handling | Base64 encode iMessage attachments → pass to RocketRide LLM context | Vision-capable models can analyze images. |
