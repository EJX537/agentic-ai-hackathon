/**
 * Agent Orchestrator — Combines all services into a unified agent loop.
 *
 * Flow:
 *   1. Receive message (via Spectrum)
 *   2. Recall relevant memories by category group (via XTrace)
 *   3. Run RocketRide pipeline with enriched context (CORE)
 *   4. Custom agent logic (MOCKED for now):
 *      a. Search web (Tavily/SearXNG — mocked)
 *      b. Scrape/extract content (Trafilatura — mocked)
 *      c. Browse live pages (Puppeteer+AX — mocked)
 *   5. Classify results into a category (via Butterbase AI Gateway)
 *   6. Persist findings as memories, grouped by category (via XTrace)
 *   7. Store session in database (via Butterbase DB)
 *   8. Reply through messaging (via Spectrum)
 *
 * RocketRide is the execution core — every agent action is a pipeline run.
 */
import { RocketRideService, type PipelineOptions, type SendOptions } from "../pipelines/ai-pipeline.ts";
import { MessagingService } from "../messaging/spectrum.ts";
import { MemoryService } from "../memory/xtrace-memory.ts";
import { BackendService } from "../backend/butterbase.ts";
import { searchWeb, type SearchResult } from "../tools/search.ts";
import { scrapePages, type ScrapedContent } from "../tools/scrape.ts";
import type { AgentContext, Message } from "../types/index.ts";
import { config } from "../config/env.ts";

export interface OrchestratorOptions {
  /** RocketRide pipeline options (filepath, inline config, or server-side ID) */
  pipeline: PipelineOptions;
  /** Default user ID fallback */
  defaultUserId?: string;
  /** XTrace group IDs for shared memory recall */
  memoryGroupIds?: string[];
  /** Butterbase app ID for state persistence */
  butterbaseAppId?: string;
}

/** Category groups used to organize XTrace memory at ingest time. */
const CATEGORY_DEFS: Array<{ name: string; prompt: string }> = [
  {
    name: "food",
    prompt:
      "Restaurants, recipes, ingredients, dining experiences, food reviews, " +
      "meal planning, dietary restrictions, cuisine types, and grocery shopping.",
  },
  {
    name: "travel",
    prompt:
      "Destinations, hotels, flights, itineraries, travel tips, local attractions, " +
      "transportation, cultural events, and vacation planning.",
  },
  {
    name: "tech",
    prompt:
      "Software, programming languages, frameworks, AI/ML, APIs, developer tools, " +
      "hardware reviews, tech news, and coding tutorials.",
  },
  {
    name: "shopping",
    prompt:
      "Product recommendations, price comparisons, online stores, deals and discounts, " +
      "reviews, buying guides, and e-commerce listings.",
  },
  {
    name: "news",
    prompt:
      "Current events, headlines, world news, political developments, business news, " +
      "science discoveries, and sports updates.",
  },
  {
    name: "other",
    prompt:
      "Content that does not clearly belong to any of the specific categories " +
      "above — catch-all for uncategorised information.",
  },
] as const;

type Category = (typeof CATEGORY_DEFS)[number]["name"];

export class AgentOrchestrator {
  /** RocketRide is the execution core — every agent action flows through it. */
  private rocketride: RocketRideService;
  private messaging: MessagingService;
  private memory: MemoryService;
  private backend: BackendService;
  private options: OrchestratorOptions;

  /** Mapping of category name → XTrace group ID (resolved at startup). */
  private categoryGroups = new Map<Category, string>();

  constructor(options: OrchestratorOptions) {
    this.rocketride = new RocketRideService(options.pipeline);
    this.messaging = new MessagingService();
    this.memory = new MemoryService();
    this.backend = new BackendService();
    this.options = options;
  }

  /**
   * Start the full agent loop.
   */
  async start(): Promise<void> {
    console.log("[AgentOrchestrator] Starting...");

    // ── 0a. Register XTrace category groups ─────────────────────────
    // Every memory gets tagged with the group it belongs to so recall()
    // can scope by category (food, travel, tech, …).
    try {
      for (const def of CATEGORY_DEFS) {
        const { id } = await this.memory.registerGroup({
          name: def.name,
          prompt: def.prompt,
        });
        this.categoryGroups.set(def.name, id);
      }
      console.log(
        "[AgentOrchestrator] XTrace groups registered:",
        [...this.categoryGroups.entries()].map(([k, v]) => `${k}=${v}`).join(", "),
      );
    } catch (err) {
      console.warn("[AgentOrchestrator] XTrace group registration failed — using fallback IDs:", err);
      // Fallback: use the category names themselves as group IDs
      for (const def of CATEGORY_DEFS) {
        this.categoryGroups.set(def.name, `web-${def.name}`);
      }
    }

    // ── 0b. Authenticate with Butterbase (mandatory: auth) ──────────
    if (config.butterbase.authEmail && config.butterbase.authPassword) {
      try {
        await this.backend.signIn({
          email: config.butterbase.authEmail,
          password: config.butterbase.authPassword,
        });
      } catch (err) {
        console.warn(
          "[AgentOrchestrator] Butterbase auth failed — continuing without DB persistence:",
          err,
        );
      }
    } else {
      console.warn("[AgentOrchestrator] No Butterbase auth credentials — skipping DB persistence");
    }

    // ── 1. Connect to RocketRide (the core execution engine) ─────────
    const token = await this.rocketride.connect();
    console.log(`[AgentOrchestrator] RocketRide ready — token=${token}`);

    // ── 2. Initialise Spectrum messaging ─────────────────────────────
    await this.messaging.init();

    // ── 3. Register the message handler ──────────────────────────────
    this.messaging.listen(async (msg) => {
      const userId = msg.user_id ?? this.options.defaultUserId ?? "anonymous";
      const convId = msg.conv_id ?? crypto.randomUUID();

      try {
        // ═══════════════════════════════════════════════════════════════
        //  STEP A — Recall memories from ALL category groups
        //  The agent checks what it already knows before searching again.
        // ═══════════════════════════════════════════════════════════════
        const allGroupIds = [...this.categoryGroups.values()];
        const recallResult = await this.memory.recall(msg.content, userId, allGroupIds);
        console.log(
          `[AgentOrchestrator] XTrace recall — ${recallResult.prompt.length} chars of context across ${allGroupIds.length} groups`,
        );

        // ═══════════════════════════════════════════════════════════════
        //  STEP B — Run the RocketRide pipeline
        // ═══════════════════════════════════════════════════════════════
        const sendOpts: SendOptions = {
          text: msg.content,
          context: {
            memories: recallResult.prompt,
            userId,
            conversationId: convId,
          },
        };
        const pipelineResult = await this.rocketride.send(sendOpts);
        const pipelineReply = pipelineResult.text;
        console.log(`[AgentOrchestrator] RocketRide pipeline done — ${pipelineReply.length} chars`);

        // ═══════════════════════════════════════════════════════════════
        //  STEP C — Custom agent logic (MOCKED)
        //  Real impl: search → scrape → browse → classify
        // ═══════════════════════════════════════════════════════════════

        // C1. Search the web (mocked)
        const searchResults = await this._searchWeb(msg.content);
        const sources = searchResults.map((r) => r.url);

        // C2. Scrape/extract content from found pages (mocked)
        const scrapedPages = await this._scrapeContent(sources.slice(0, 2));

        // C3. Classify the query into a category using Butterbase AI gateway
        const category = await this._classifyQuery(msg.content);
        const categoryGroupId = this.categoryGroups.get(category) ?? this.categoryGroups.get("other") ?? "web-other";
        console.log(
          `[AgentOrchestrator] Search classified as "${category}" → group ${categoryGroupId}`,
        );

        // Build final reply (pipeline output + scraped sources)
        const finalReply = [
          pipelineReply,
          "",
          "── Sources ──",
          ...scrapedPages.map((p) => `• ${p.title}: ${p.url}`),
        ].join("\n");

        // ═══════════════════════════════════════════════════════════════
        //  STEP D — Persist findings as XTrace memories, GROUPED by category
        //
        //  The ingest-time classifier tags each extracted memory with the
        //  category group it belongs to.  Later, recall() can scope by
        //  group so the agent only sees relevant memories.
        // ═══════════════════════════════════════════════════════════════

        // D1. Ingest the conversation turn — tagged with the category group
        await this.memory.ingestMessages(
          [msg, { role: "assistant", content: finalReply }],
          userId,
          convId,
          [categoryGroupId],
        );
        console.log(`[AgentOrchestrator] XTrace ingested conversation → group ${categoryGroupId}`);

        // D2. Ingest each scraped page separately — tagged with the same group
        //     so the agent can later ask "what do I know about this domain?".
        for (const page of scrapedPages) {
          await this.memory.ingestMessages(
            [
              {
                role: "system",
                content: `Website found while researching "${msg.content}"`,
              },
              {
                role: "assistant",
                content: `URL: ${page.url}\nTitle: ${page.title}\n\nExtracted content:\n${page.content.slice(0, 1000)}`,
              },
            ],
            userId,
            `${convId}:page:${page.url}`,
            [categoryGroupId],
          );
        }
        console.log(
          `[AgentOrchestrator] Ingested ${scrapedPages.length} page memories → group ${categoryGroupId}`,
        );

        // ═══════════════════════════════════════════════════════════════
        //  STEP E — Store session in Butterbase DB
        // ═══════════════════════════════════════════════════════════════
        if (this.backend.isAuthenticated && this.options.butterbaseAppId) {
          const session = await this.backend.insertSession({
            user_id: userId,
            query_text: msg.content,
            category,
            reply_text: finalReply,
            source_count: sources.length,
          });

          for (const page of scrapedPages) {
            await this.backend.cachePage({
              url: page.url,
              title: page.title,
              content: page.content,
              category,
            });
          }

          console.log(`[AgentOrchestrator] Butterbase saved — session=${session?.id ?? "failed"}`);
        }

        return finalReply;
      } catch (err) {
        console.error("[AgentOrchestrator] Error processing message:", err);
        return "Sorry, I encountered an error processing your request.";
      }
    });

    console.log("[AgentOrchestrator] Agent loop running.");
  }

  /**
   * Graceful shutdown — disconnect RocketRide, stop messaging.
   */
  async shutdown(): Promise<void> {
    await this.rocketride.disconnect();
    await this.messaging.shutdown();
  }

  // ═══════════════════════════════════════════════════════════════════
  //  MOCKED STEPS (Phase 2: replace with real implementations)
  // ═══════════════════════════════════════════════════════════════════

  private async _searchWeb(query: string): Promise<SearchResult[]> {
    console.log(`[AgentOrchestrator:MOCK] Searching web for "${query}"`);
    return searchWeb(query, { maxResults: 3 });
  }

  private async _scrapeContent(urls: string[]): Promise<ScrapedContent[]> {
    console.log(`[AgentOrchestrator:MOCK] Scraping ${urls.length} URLs`);
    return scrapePages(urls);
  }

  private async _classifyQuery(query: string): Promise<Category> {
    if (!this.backend.isAuthenticated) return "other";

    try {
      const label = await this.backend.classifyText(query);
      const names = CATEGORY_DEFS.map((d) => d.name) as string[];
      const category = (names.includes(label) ? label : "other") as Category;
      console.log(`[AgentOrchestrator] Classified as "${category}"`);
      return category;
    } catch (err) {
      console.warn("[AgentOrchestrator] Classification failed, defaulting to other:", err);
      return "other";
    }
  }
}
