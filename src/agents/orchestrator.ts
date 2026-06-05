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

/** Category groups used to organize XTrace memory. */
const CATEGORY_GROUPS = ["food", "travel", "tech", "shopping", "news", "other"] as const;
type Category = (typeof CATEGORY_GROUPS)[number];

export class AgentOrchestrator {
  /** RocketRide is the execution core — every agent action flows through it. */
  private rocketride: RocketRideService;
  private messaging: MessagingService;
  private memory: MemoryService;
  private backend: BackendService;
  private options: OrchestratorOptions;
  /** Mapping of category → XTrace group ID (set from env or defaults). */
  private categoryGroups = new Map<Category, string>();
  /** Incrementing mock counter so each run looks different. */
  private _mockRun = 0;

  constructor(options: OrchestratorOptions) {
    this.rocketride = new RocketRideService(options.pipeline);
    this.messaging = new MessagingService();
    this.memory = new MemoryService();
    this.backend = new BackendService();
    this.options = options;

    // Map categories to group IDs (use first N from env, or auto-generate)
    const groupIds = options.memoryGroupIds ?? [];
    for (const [i, category] of CATEGORY_GROUPS.entries()) {
      this.categoryGroups.set(category, groupIds[i] ?? `web-${category}`);
    }
  }

  /**
   * Start the full agent loop.
   */
  async start(): Promise<void> {
    console.log("[AgentOrchestrator] Starting...");

    // ── 0. Authenticate with Butterbase (mandatory: auth) ────────────
    if (config.butterbase.authEmail && config.butterbase.authPassword) {
      try {
        await this.backend.signIn({
          email: config.butterbase.authEmail,
          password: config.butterbase.authPassword,
        });
      } catch (err) {
        console.warn("[AgentOrchestrator] Butterbase auth failed — continuing without DB persistence:", err);
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
      this._mockRun++;

      const context: AgentContext = {
        userId,
        conversationId: convId,
        recentMessages: [msg],
        recalledMemories: [],
      };

      try {
        // ═══════════════════════════════════════════════════════════════
        //  STEP A — Recall memories from all category groups
        // ═══════════════════════════════════════════════════════════════
        const groupIds = [...this.categoryGroups.values()];
        const recallResult = await this.memory.recall(msg.content, userId, groupIds);
        console.log(`[AgentOrchestrator] XTrace recall — ${recallResult.prompt.length} chars of context`);

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

        // Combine pipeline reply with scraped context
        const finalReply = [
          pipelineReply,
          "",
          "── Sources ──",
          ...scrapedPages.map((p) => `• ${p.title}: ${p.url}`),
        ].join("\n");

        // ═══════════════════════════════════════════════════════════════
        //  STEP D — Persist findings as memories, grouped by category
        // ═══════════════════════════════════════════════════════════════
        const categoryGroupId = this.categoryGroups.get(category) ?? this.categoryGroups.get("other") ?? "web-other";

        // Ingest the conversation into XTrace with the category group
        await this.memory.ingestMessages(
          [msg, { role: "assistant", content: finalReply }],
          userId,
          convId,
        );
        console.log(`[AgentOrchestrator] XTrace ingested — category="${category}" group=${categoryGroupId}`);

        // Store each scraped page as a separate memory fact
        for (const page of scrapedPages) {
          await this.memory.ingestMessages(
            [
              { role: "system", content: `Website: ${page.url}` },
              { role: "assistant", content: `Title: ${page.title}\n\nContent:\n${page.content.slice(0, 1000)}` },
            ],
            userId,
            `${convId}:page:${page.url}`,
          );
        }
        console.log(`[AgentOrchestrator] Ingested ${scrapedPages.length} page memories`);

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

          // Cache scraped pages
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

  /**
   * Mock: search the web.
   * Phase 2 → use Tavily AI or SearXNG + Trafilatura.
   */
  private async _searchWeb(query: string): Promise<SearchResult[]> {
    console.log(`[AgentOrchestrator:MOCK] Searching web for "${query}"`);
    return searchWeb(query, { maxResults: 3 });
  }

  /**
   * Mock: scrape/extract content from URLs.
   * Phase 2 → use Trafilatura (Python) + Puppeteer+AX for JS pages.
   */
  private async _scrapeContent(urls: string[]): Promise<ScrapedContent[]> {
    console.log(`[AgentOrchestrator:MOCK] Scraping ${urls.length} URLs`);
    return scrapePages(urls);
  }

  /**
   * Classify the query into a category using Butterbase AI Gateway.
   * Falls back to "other" if Butterbase is unavailable.
   */
  private async _classifyQuery(query: string): Promise<Category> {
    if (!this.backend.isAuthenticated) return "other";

    try {
      const label = await this.backend.classifyText(query);
      const category = CATEGORY_GROUPS.includes(label as Category)
        ? (label as Category)
        : "other";
      console.log(`[AgentOrchestrator] Classified as "${category}"`);
      return category;
    } catch (err) {
      console.warn("[AgentOrchestrator] Classification failed, defaulting to other:", err);
      return "other";
    }
  }
}
