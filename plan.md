# Web Research Agent — Architecture Plan

## Overview

An iMessage-connected agent that researches the web on your behalf. Send a query with text + images, and the agent searches indexed pages (Tavily/SearXNG) and live JS-heavy pages (AX + Puppeteer), remembers what it learns organized by category, and replies with curated results.

---

## 1. Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  iMessage ──→ Spectrum ──→ AgentOrchestrator ──→ RocketRide (injest)   │
│                           ↑                              │               │
│                           │                              ▼               │
│                        XTrace ◄── Custom Agent (orchestrator.ts)        │
│                           │                              │               │
│                           │                              ▼               │
│                      Butterbase ◄─────────────────── Store results      │
│                           │                              │               │
│                           └──────────── Spectrum ────────┘               │
│                                        │                                │
│                                        ▼                                │
│                                    iMessage                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Message cycle

```
iMessage ──send──→ Spectrum
                        │
                        ▼
                 orchestrator.start()
                        │
               ┌────────┴──────────────┐
               │ 1. XTrace.recall()    │ ← pull memories by group (food, travel, ...)
               │ 2. Query RocketRide   │ ──send()──→ injest.pipe
               │ 3. Custom logic:      │
               │    a. Tavily/SearXNG  │ ← search indexed web
               │    b. Trafilatura     │ ← extract content from found pages
               │    c. Puppeteer+AX    │ ← browse live JS pages, perform actions
               │    d. XTrace.ingest() │ ← store findings by category group
               │ 4. Butterbase.save()  │ ← persist results
               │ 5. Reply via Spectrum │ ← send answer to iMessage
               └───────────────────────┘
```

---

## 2. Component Breakdown

### 2a. RocketRide Pipeline (`pipelines/injest.pipe`)

The pipeline serves as the orchestration entry point. It receives the user's query (text + image references) from the orchestrator and returns the final answer.

```json
Chat Source ──→ [Agent/LLM nodes] ──→ Return Answers
```

The orchestrator calls `rocketride.send()` with the query, the pipeline processes it through agent/LLM nodes, and the result comes back to the orchestrator for post-processing (memory storage, state persistence, reply).

### 2b. Custom Agent Logic (in `orchestrator.ts`)

The heavy lifting lives in the orchestrator's message handler. The RocketRide pipeline handles LLM reasoning; the TypeScript layer handles tool integration:

| Step | Tool | Purpose |
|---|---|---|
| Memory recall | XTrace `recall()` | Pull relevant knowledge by group before searching |
| Web search (indexed) | Tavily AI API or SearXNG | Find relevant pages for the query |
| Page extraction | Trafilatura | Extract clean text from indexed pages |
| Live browsing | Puppeteer + AX | Navigate JS-heavy pages, fill forms, click, scrape |
| Content memory | XTrace `ingest()` | Store page content grouped by category (food, travel, ...) |
| Memory pull per site | XTrace `recall()` | Before visiting a new site, check what's already known in its group |
| State persistence | Butterbase DB | Store search sessions, results, user preferences |
| AI fallback/reasoning | Butterbase AI Gateway | Optional: direct model access for classification/summarization |

### 2c. Memory Architecture (XTrace)

Websites are ingested into XTrace organized by **group**, where each group is a content category:

```
Groups:  "food", "travel", "tech", "shopping", "news", ...

Memory per group:
  - Site URLs discovered
  - Key facts extracted
  - Page summaries
  - Actions available on the page (from AX scan)
```

**Flow:**
1. User sends "Find me Italian restaurants in SF"
2. Orchestrator calls `xtrace.recall("Italian restaurants SF", { group_ids: ["food"] })`
3. If memories exist → skip search, return cached + updated info
4. If no/old memories → Tavily search → visit pages → extract → `xtrace.ingest({ group_ids: ["food"] })`
5. When browsing a specific restaurant site → `xtrace.recall("dominoc餐厅.com", { group_ids: ["food"] })` to check what's already known about that domain

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
| **Database** | `client.from("sessions").insert(...)` — store search sessions, results per query, user preferences, website cache |
| **Auth** | `client.auth.signIn()` — authenticate the iMessage user identity, scope data per user |
| **AI Model Gateway** | `client.ai.chat()` — fallback LLM for classification (categorize search results), summarization, content extraction when RocketRide is overkill |
| **KV (existing)** | Keep for ephemeral state (conversation TTL cache) |

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

The orchestrator sends to RocketRide via `send()` with a structured payload:

```ts
const result = await rocketride.send({
  text: userQuery,
  context: {
    memories: memoryContext,   // from XTrace recall
    images: imageRefs,         // from iMessage attachments
    searchResults: searchJson, // from Tavily/SearXNG (optional, or let pipeline search)
    userId,
    conversationId,
  },
});
```

The pipeline's LLM agent receives this as context and produces a final answer. The orchestrator then:
1. Ingests the answer + sources into XTrace (categorized by group)
2. Saves the session to Butterbase DB
3. Sends the reply via Spectrum

---

## 4. Implementation Order

```
Phase 1: Core search loop
  └─ Tavily/SearXNG integration (search tool)
  └─ Trafilatura content extraction (scrape tool)
  └─ Wire into orchestrator's message handler
  └─ Test: "Find me X" → search → return results via iMessage

Phase 2: XTrace memory by group
  └─ Define category groups (food, travel, tech, ...)
  └─ Ingest visited pages by group
  └─ Recall before search and per-domain
  └─ Test: same query twice → second is instant from memory

Phase 3: Live browsing (Puppeteer + AX)
  └─ Use Puppeteer for JS-heavy pages
  └─ AX scan for interactive elements
  └─ Agent decides actions (click, fill, screenshot)
  └─ Test: "Check prices on this dynamic site"

Phase 4: Butterbase integration
  └─ Define DB schema (sessions, results, cache)
  └─ Butterbase AI gateway for classification/summarization
  └─ Auth for user identity
  └─ Persist search history and preferences

Phase 5: Polish & pipeline tuning
  └─ Optimize injest.pipe topology
  └─ Handle image inputs via iMessage
  └─ Error handling, rate limiting, timeouts
```

---

## 5. File Map (what to add/modify)

| File | Change |
|---|---|
| `src/tools/search.ts` | **New** — Tavily/SearXNG client |
| `src/tools/scrape.ts` | **New** — Trafilatura content extraction |
| `src/tools/classify.ts` | **New** — Butterbase AI gateway for categorization |
| `src/memory/xtrace-service.ts` | **New** — Memory service with group-aware recall/ingest (wraps existing MemoryService with group support) |
| `src/agents/orchestrator.ts` | **Modify** — Add search, browse, memory-group logic to message handler |
| `src/backend/butterbase.ts` | **Modify** — Add typed DB client, auth, AI gateway methods |
| `pipelines/injest.pipe` | **Modify** — Design the agent pipeline topology |
| `src/browser/browser-agent.ts` | **Keep** — already does Puppeteer + AX |
| `src/index.ts` | **Keep** — entry point is correct |

---

## 6. Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Search API | Tavily (primary), SearXNG (fallback) | Tavily gives extracted content + results in one call. SearXNG for uncensored results. |
| Content extraction | Trafilatura (Python, call via `exec`/subprocess) | Best-in-class boilerplate removal. Falls back to Puppeteer text extract for JS pages. |
| Page interaction | Puppeteer + AX | Already have it. AX discovers actions, Puppeteer executes them. |
| Memory grouping | XTrace `group_ids` | Native XTrace feature. Each category is a group. |
| Image handling | Base64 encode iMessage attachments → pass to RocketRide LLM context | Vision-capable models can analyze images. |
| Butterbase AI gateway | Used for classification + summarization (not primary LLM) | Meet mandatory requirement without duplicating RocketRide. |
