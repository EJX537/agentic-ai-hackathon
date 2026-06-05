# Agentic AI Hub — Full Pipeline Architecture

## Overview

An **iMessage-connected Web Research Agent** — send a query (text + images) and the agent searches indexed pages via SearXNG, browses JS-heavy sites via Puppeteer + AX, remembers what it learns organized by category via XTrace, and replies with curated results via Spectrum.

The four hackathon technologies are woven into a single end-to-end flow:

| Technology | Role |
|---|---|
| **🚀 RocketRide** | Core AI pipeline — LLM reasoning + XTrace recall + Butterbase MCP tools |
| **🧈 Butterbase** | Backend — AI Model Gateway (pipeline LLM + classification), DB persistence, MCP admin tools |
| **🧠 XTrace** | Long-term memory — structured recall by category group, ingest by category |
| **💬 Spectrum (Photon)** | Messaging — iMessage + terminal delivery |

---

## End-to-End Data Flow

```
iMessage ──→ Spectrum ──→ AgentOrchestrator
                                │
                    1. XTrace Recall (all 6 category groups)
                                │
                    2. RocketRide Pipeline ──→ LLM reasoning (Butterbase AI Gateway)
                                                    ├── XTrace recall/remember
                                                    ├── Butterbase MCP tools (DB, schema, auth)
                                                    └── Internal memory scratchpad
                                │
                    3. WebUseAgent (embedded pi agent)
                          ├── SearXNG search + URL readers (static content)
                          └── Puppeteer + AX navigation (JS-heavy / interactive pages)
                                │
                    4. XTrace Ingest (by detected category)
                    5. Butterbase DB Persist (search session record)
                                │
                          Spectrum ──→ iMessage reply
```

---

## Stage 1: Receive — Spectrum Messaging

**File:** `src/messaging/spectrum.ts`

Spectrum connects to iMessage (and terminal for local dev). When a message arrives:

```ts
this.messaging.listen(async (msg) => {
  const userId = msg.user_id ?? "anonymous";
  const convId = msg.conv_id ?? crypto.randomUUID();
  // → Stage 2
});
```

✓ **Mandatory requirement:** Photon integration — agent delivered through a real messaging platform (iMessage).

---

## Stage 2: Recall — XTrace Memory

**File:** `src/memory/xtrace-memory.ts`

Six category groups are registered at startup — each with a name and semantic prompt:

| Group | Semantics |
|---|---|
| **food** | Restaurants, recipes, ingredients, dining experiences, food reviews, cuisine types |
| **travel** | Destinations, hotels, flights, itineraries, travel tips, local attractions |
| **tech** | Software, programming, frameworks, AI/ML, APIs, developer tools, tutorials |
| **shopping** | Product recommendations, price comparisons, online stores, reviews, buying guides |
| **news** | Current events, headlines, world news, business, science, sports |
| **other** | Catch-all for content that doesn't fit the above |

Before any processing, the orchestrator searches all groups for relevant memories:

```ts
const allGroupIds = [...this.categoryGroups.values()];
const recallResult = await this.memory.recall(msg.content, userId, allGroupIds);
```

The recalled context is passed into the RocketRide pipeline so the LLM is already grounded in what the user has learned before.

✓ **Mandatory requirement:** XTrace Integration — agents actively write to and read from persistent history. Three touch points:
- Pipeline start: `xtrace.recall` grounds the LLM
- WebUseAgent mid-browse: `recall_memory` / `remember_fact` tools
- Orchestrator end-of-turn: `memory.ingestMessages` by category group

---

## Stage 3: Process — RocketRide Pipeline

**File:** `pipelines/injest.pipe` → executed via `src/pipelines/ai-pipeline.ts`

The orchestrator sends the query + XTrace context to the pipeline:

```ts
const result = await this.rocketride.send({
  text: msg.content,
  context: {
    memories: recallResult.prompt,  // XTrace context from previous sessions
    userId,
    conversationId: convId,
  },
});
```

### Pipeline Topology (7 nodes)

```
┌──────────┐     ┌──────────────────┐     ┌──────────────┐
│   Chat   │────▶│ RocketRide Wave  │────▶│    Return     │
│  Source  │     │     Agent        │     │   Answers    │
└──────────┘     └────────┬─────────┘     └──────────────┘
                          │
            ┌─────────────┼──────────────┐
            │             │              │
            ▼             ▼              ▼
    ┌────────────┐ ┌───────────┐ ┌──────────────┐
    │ Butterbase │ │  XTrace   │ │   Internal   │
    │ AI Gateway │ │  Memory   │ │   Memory     │
    │ (LLM)      │ │  Tool     │ │   (scratch)  │
    └────────────┘ └───────────┘ └──────────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │  Butterbase MCP  │
                 │  (DB / Auth /    │
                 │   Schema / Funcs)│
                 └──────────────────┘
```

### Node Details

| Node | Provider | Config |
|---|---|---|
| **Chat** | `chat` | Entry point — receives user query from orchestrator |
| **RocketRide Wave** | `agent_rocketride` | 15 max waves — orchestrates tool calls (recall → reason → remember → MCP ops) |
| **Butterbase AI Gateway** | `llm_openai_api` | `google/gemini-3.5-flash` via `https://api.butterbase.ai/v1` (OpenAI-compatible) |
| **Internal Memory** | `memory_internal` | Short-term working notes for the current run |
| **XTrace Memory** | `tool_xtrace_memory` | `xtrace.recall` at start of turn, `xtrace.remember` after answering |
| **Butterbase MCP Client** | `tool_butterbase` | 47+ MCP tools via `https://api.butterbase.ai/mcp` (Streamable HTTP) |
| **Return Answers** | `response_answers` | Sends pipeline output back to orchestrator |

### Agent Instructions

The Wave agent is instructed to:

1. **Recall** — call `xtrace.recall` with a query about what you need to know
2. **Ground your answer** — use returned context for personalization
3. **Use Butterbase tools** — for schema, auth, data queries, functions
4. **Remember** — call `xtrace.remember` after answering to persist
5. **Format** — direct answer → key findings → caveats, under 400 words

### Butterbase MCP Tools (47+)

The pipeline LLM can call any MCP tool for backend operations:

| Category | Tools |
|---|---|
| **Schema** | `manage_schema` (get/apply/dry_run/list_migrations) |
| **Data** | `select_rows`, `insert_row`, `update_rows`, `delete_rows` |
| **Auth** | `manage_rls`, `create_user_isolation_policy`, `manage_oauth`, `manage_jwt` |
| **Storage** | `manage_storage`, `create_upload_url`, `create_download_url` |
| **Functions** | `deploy_function`, `invoke_function`, `list_functions` |
| **AI** | `manage_ai`, `manage_rag`, `rag_query`, `manage_rag_content` |
| **Audit** | `query_audit_logs`, `manage_audit_policies` |
| **App** | `manage_app`, `manage_billing`, `manage_api_keys` |

✓ **Mandatory requirement:** RocketRide — pipeline meaningfully connected to core agent logic.

✓ **Mandatory requirement:** Butterbase — database, auth, and AI Model Gateway all provisioned and served.

---

## Stage 4: Browse — WebUseAgent (Embedded pi Coding Agent)

**Files:** `src/webuse/web-use-agent.ts`, `src/webuse/tools.ts`, `src/webuse/searxng.ts`, `src/webuse/sites/*.ts`

After the pipeline returns its analysis, the orchestrator spawns an **embedded pi-coding-agent session** with 13 custom tools for autonomous web research:

```ts
const { session } = await createAgentSession({
  model,
  authStorage: this.authStorage,
  modelRegistry: this.modelRegistry,
  sessionManager: SessionManager.inMemory(),
  noTools: "builtin",        // only our tools, no pi built-ins
  customTools: webUseTools,   // 13 custom tools
});
```

The pi agent receives a prompt with the task, XTrace memory context, and tool descriptions, then autonomously executes a two-phase strategy:

### Phase 1: Search & Read (Static Content)

| Tool | Backend | What it does |
|---|---|---|
| `search_web` | **SearXNG** (self-hosted metasearch) | Searches multiple engines, returns URLs + titles + snippets |
| `read_url` | **Trafilatura** + 6 site-specific handlers | Extracts clean Markdown from any URL |

The agent searches first, then reads promising URLs to gather information.

### Phase 2: Browse (JS-Heavy / Interactive Pages)

| Tool | Backend | What it does |
|---|---|---|
| `navigate` | **Puppeteer** | Navigates to any URL with a real browser |
| `scan` | **AX** (accessibility tree) | Scans the page — returns interactive elements with IDs |
| `click` | Puppeteer + AX | Clicks buttons, links, toggles by node ID |
| `fill` | Puppeteer + AX | Types into form fields by node ID |
| `view` | Puppeteer + AX | Reads text from a specific element |
| `page_text` | Puppeteer | Returns all visible page text (up to 10K chars) |
| `screenshot` | Puppeteer | Captures a base64 PNG for vision-capable models |

The agent uses `scan()` after every action to see the new page state, then decides what to click/fill next.

### Site-Specific URL Handlers

`src/webuse/sites/` — Six optimized handlers using their platform APIs:

| Handler | API | Extracts |
|---|---|---|
| **Wikipedia** | REST `/page/summary` | Title + extract + description |
| **GitHub** | `raw.githubusercontent.com` | Code files with language-detected syntax fences |
| **YouTube** | oEmbed + Trafilatura fallback | Metadata + transcript/description |
| **Stack Overflow** | Stack Exchange API v2.3 | Question body + top 5 answers with scores |
| **MDN** | MDN API v1 | Title + summary + body |
| **Reddit** | RSS / `old.reddit.com` | Listings + post content |
| **Trafilatura** (generic fallback) | Python CLI | HTML → clean Markdown (strips nav/ads/boilerplate) |

### Memory Tools

The agent also has direct XTrace access mid-browse:

| Tool | What it does |
|---|---|
| `recall_memory` | Semantic search of past sessions via XTrace |
| `remember_fact` | Persists important findings to XTrace mid-session |

### Completion

When done, the agent calls:

```
done(summary="what I found and did")
```

Which returns `## Result\n\n{summary}`. The orchestrator extracts this and uses it as the final answer.

---

## Stage 5: Classify + Ingest + Persist

After the WebUseAgent returns, the orchestrator:

### 5a. Classify — Butterbase AI Gateway

```ts
const category = await this.backend.classifyText(finalAnswer);
// → "food", "travel", "tech", "shopping", "news", "other"
```

Uses `openai/gpt-4o-mini` via Butterbase AI Gateway (`client.ai.chat()`) for zero-shot classification with temperature 0.

### 5b. Ingest — XTrace Memory (by category)

```ts
const groupId = this.categoryGroups.get(category) ?? this.categoryGroups.get("other");
await this.memory.ingestMessages(
  [userMessage, assistantReply],
  userId,
  convId,
  [groupId],  // tagged with the detected category group
);
```

This ensures future recall for the same topic finds relevant past findings.

### 5c. Persist — Butterbase DB

```ts
await this.backend.insertSession({
  user_id: userId,
  query_text: msg.content,
  category,
  reply_text: finalAnswer,
});
```

The `search_sessions` table stores every interaction for audit, history, and analytics.

---

## Stage 6: Reply — Spectrum

The orchestrator returns the final answer:

```ts
return finalAnswer;
```

Spectrum delivers it through the same messaging channel (iMessage).

---

## Memory Architecture (XTrace)

### Three Touch Points

```
Start of turn                        End of turn
     │                                    │
     ▼                                    ▼
Pipeline                       Orchestrator
───────────                    ────────────
xtrace.recall()                memory.ingestMessages()
→ grounds LLM response         → persists by category group
                                → available for future recall
                                     │
                               Mid-browse (WebUseAgent)
                               ─────────────────────────
                               recall_memory tool
                               → searches past sessions for context
                               
                               remember_fact tool
                               → saves important findings mid-session
```

---

## Butterbase — Full Stack

### AI Model Gateway (three uses)

| Usage | Model | Integration |
|---|---|---|
| Pipeline LLM | `google/gemini-3.5-flash` | `llm_openai_api` node → `https://api.butterbase.ai/v1` |
| Classification | `openai/gpt-4o-mini` | `@butterbase/sdk` `client.ai.chat()` |
| Summarization | `openai/gpt-4o-mini` | `@butterbase/sdk` `client.ai.chat()` |

### Database Schema (managed via MCP)

```sql
search_sessions:
  id            uuid PK      — gen_random_uuid()
  user_id       text         — iMessage user identifier
  query_text    text         — the user's original query
  image_refs    text?        — base64 encoded image data
  category      text?        — classified category label
  reply_text    text?        — the agent's final answer
  source_count  int?         — number of sources consulted
  created_at    timestamptz  — now()
```

### MCP (Model Context Protocol)

The pipeline's Wave agent accesses Butterbase via **47+ MCP tools** over Streamable HTTP at `https://api.butterbase.ai/mcp`. This covers everything beyond basic CRUD: schema management, RLS policies, storage upload URLs, function deployment, OAuth config, audit log queries, and billing.

---

## Integration Tests

### `tests/integration.test.ts` (560 lines)

Full pipeline test with mocked services (Spectrum, RocketRide, XTrace, Butterbase). Validates:
- Complete 6-stage flow produces correct step ordering
- Classification resolves to correct category per query content
- XTrace recall context is injected into the pipeline
- XTrace ingest groups findings by category
- Session persistence captures reply text and metadata
- Error paths (auth failure, empty queries) are handled gracefully

### `tests/webuse/tools.test.ts` (280 lines)

Real service integration tests:
- **SearXNG**: search returns formatted results with URLs and snippets
- **Wikipedia / GitHub / MDN**: URL readers return clean markdown with correct metadata
- **XTrace**: recall returns memories; ingest persists and recall can find them
- **Puppeteer**: navigate, scan, page_text, screenshot all work against real pages
- **Amazon.com demo**: full workflow — navigate to Amazon → search → sort → filter → extract top 3 results

### `tests/webuse/web-use-agent.test.ts` (155 lines)

Unit tests for the embedded pi agent:
- `buildPrompt()` includes task, memory context, tool list, and escalation criteria
- Memory context injection section appears only when context is provided
- Tool context propagates to all tools correctly
- Error paths (browser throws → user-friendly error message)

---

## Mandatory Requirements

| Requirement | How It's Met |
|---|---|
| **RocketRidge** — core data/AI pipeline | 7-node `injest.pipe`: Chat → Wave Agent (15 waves) → LLM + XTrace tool + Butterbase MCP + Internal Memory → Return Answers |
| **Butterbase** — DB, auth, AI Gateway | AI Gateway as pipeline LLM + orchestrator classifier; MCP tools for schema/DB/auth; SDK client for session persistence |
| **XTrace** — persistent memory read/write | Pipeline `xtrace.recall`/`xtrace.remember`; orchestrator `ingestMessages` by category group; WebUseAgent `recall_memory`/`remember_fact` tools |
| **Spectrum** — real messaging platform | iMessage + terminal adapters; `listen()` receives messages, handler returns replies |
| **Deep integration** — all four in core experience | Every stage of the 6-stage flow uses at least 2 technologies simultaneously. No technology is a bolt-on. |

---

## File Map

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — validates env, initializes all services, graceful shutdown |
| `src/config/env.ts` | Centralized typed env config (RocketRide, Spectrum, XTrace, Butterbase) |
| `src/types/index.ts` | Shared types: Message, PipelineResult, MemoryFact, AgentContext |
| `src/pipelines/ai-pipeline.ts` | RocketRide SDK wrapper — `connect`, `send`, `pipe`, `chat`, `monitor` |
| `src/messaging/spectrum.ts` | Spectrum messaging — `init`, `listen`, `shutdown` |
| `src/memory/xtrace-memory.ts` | XTrace memory — `registerGroup`, `recall`, `ingestMessages`, `searchMemories` |
| `src/backend/butterbase.ts` | Butterbase SDK — `signIn`, `insertSession`, `classifyText`, `summarize`, `chat` |
| `src/agents/orchestrator.ts` | Agent orchestrator — 6-stage loop connecting all services |
| `src/webuse/web-use-agent.ts` | Embedded pi agent session — spawns agent with 13 custom tools |
| `src/webuse/tools.ts` | 13 custom tool definitions for the web-use agent |
| `src/webuse/searxng.ts` | SearXNG metasearch client — `searchWeb`, `formatSearchResults` |
| `src/webuse/read-url.ts` | URL content reader — dispatches to site-specific handlers |
| `src/webuse/sites/index.ts` | Site handler registry — routes URLs to correct handler |
| `src/webuse/sites/wikipedia.ts` | Wikipedia REST API handler |
| `src/webuse/sites/github.ts` | GitHub raw content handler (30+ code extensions) |
| `src/webuse/sites/youtube.ts` | YouTube oEmbed + Trafilatura handler |
| `src/webuse/sites/stackoverflow.ts` | Stack Exchange API v2.3 handler |
| `src/webuse/sites/mdn.ts` | MDN API v1 handler |
| `src/webuse/sites/reddit.ts` | RSS + old.reddit.com handler |
| `src/webuse/sites/trafilatura.ts` | Python Trafilatura CLI wrapper (generic fallback) |
| `src/webuse/sites/utils.ts` | HTML stripping + entity decoding utilities |
| `src/browser/puppeteer.ts` | Puppeteer browser controller — `launch`, `navigate`, `screenshot`, AX injection |
| `src/browser/browser-agent.ts` | Browser agent — `scanWithSelectors`, `invokeByNodeId`, `act`, `pageText` |
| `src/dom/ax-interface.ts` | AX DOM interface — `scan`, `invoke`, `watch`, `unwatch` |
| `pipelines/injest.pipe` | RocketRide pipeline definition — 7 nodes with instructions |
| `tests/integration.test.ts` | Full integration test with mocked services (560 lines) |
| `tests/webuse/tools.test.ts` | Real service integration tests (SearXNG, URLs, XTrace, Puppeteer) (280 lines) |
| `tests/webuse/web-use-agent.test.ts` | WebUseAgent unit tests (155 lines) |
| `docs/butterbase/ai.md` | Butterbase AI Gateway reference |
| `docs/butterbase/db.md` | Butterbase Database reference |
| `docs/pipeline.md` | This document |
