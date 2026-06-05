/**
 * Agent Preprocessor — Feeds messages through the RocketRide pipeline then
 * spawns an embedded web-use pi agent for browsing.
 *
 * Flow:
 *   Spectrum message
 *     → RocketRide pipeline (LLM reasoning + XTrace recall + Butterbase MCP)
 *     → WebUseAgent (embedded pi agent with browse/click/fill/scan tools)
 *     → XTrace ingest (store findings by category)
 *     → Butterbase DB (persist session)
 *     → Spectrum reply
 */
import { RocketRideService, Question, type PipelineOptions, type SendOptions } from "../pipelines/ai-pipeline.ts";
import { MessagingService } from "../messaging/spectrum.ts";
import { MemoryService } from "../memory/xtrace-memory.ts";
import { BackendService } from "../backend/butterbase.ts";
import { WebUseAgent } from "../webuse/web-use-agent.ts";
import type { Message } from "../types/index.ts";
import { config } from "../config/env.ts";
import type { BrowserAgent } from "../browser/browser-agent.ts";

export interface OrchestratorOptions {
  /** RocketRide pipeline options */
  pipeline: PipelineOptions;
  /** Default user ID fallback */
  defaultUserId?: string;
  /** Browser agent (for web browsing) */
  browser?: BrowserAgent;
}

/** Category groups used to organize XTrace memory at ingest time. */
const CATEGORY_DEFS: Array<{ name: string; prompt: string }> = [
  {
    name: "food",
    prompt: "Restaurants, recipes, ingredients, dining experiences, food reviews, meal planning, dietary restrictions, cuisine types, and grocery shopping.",
  },
  {
    name: "travel",
    prompt: "Destinations, hotels, flights, itineraries, travel tips, local attractions, transportation, cultural events, and vacation planning.",
  },
  {
    name: "tech",
    prompt: "Software, programming languages, frameworks, AI/ML, APIs, developer tools, hardware reviews, tech news, and coding tutorials.",
  },
  {
    name: "shopping",
    prompt: "Product recommendations, price comparisons, online stores, deals and discounts, reviews, buying guides, and e-commerce listings.",
  },
  {
    name: "news",
    prompt: "Current events, headlines, world news, political developments, business news, science discoveries, and sports updates.",
  },
  {
    name: "other",
    prompt: "Content that does not clearly belong to any of the specific categories above — catch-all for uncategorised information.",
  },
] as const;

type Category = (typeof CATEGORY_DEFS)[number]["name"];

export class AgentOrchestrator {
  private rocketride: RocketRideService;
  private messaging: MessagingService;
  private memory: MemoryService;
  private backend: BackendService;
  private webUse: WebUseAgent;
  private options: OrchestratorOptions;

  /** Category name → XTrace group ID (resolved at startup). */
  private categoryGroups = new Map<Category, string>();

  constructor(options: OrchestratorOptions) {
    this.rocketride = new RocketRideService(options.pipeline);
    this.messaging = new MessagingService();
    this.memory = new MemoryService();
    this.backend = new BackendService();
    this.webUse = new WebUseAgent();
    this.options = options;
  }

  /**
   * Start the preprocessor loop.
   */
  async start(): Promise<void> {
    console.log("[Preprocessor] Starting...");

    // ── 0a. Register XTrace category groups ─────────────────────────
    try {
      for (const def of CATEGORY_DEFS) {
        const { id } = await this.memory.registerGroup({ name: def.name, prompt: def.prompt });
        this.categoryGroups.set(def.name, id);
      }
      console.log(
        "[Preprocessor] XTrace groups:",
        [...this.categoryGroups.entries()].map(([k, v]) => `${k}=${v}`).join(", "),
      );
    } catch (err) {
      console.warn("[Preprocessor] XTrace group registration failed, using fallback IDs:", err);
      for (const def of CATEGORY_DEFS) {
        this.categoryGroups.set(def.name, `web-${def.name}`);
      }
    }

    // ── 0b. Authenticate with Butterbase ────────────────────────────
    if (config.butterbase.authEmail && config.butterbase.authPassword) {
      try {
        await this.backend.signIn({
          email: config.butterbase.authEmail,
          password: config.butterbase.authPassword,
        });
      } catch (err) {
        console.warn("[Preprocessor] Butterbase auth failed — continuing without DB:", err);
      }
    } else {
      console.warn("[Preprocessor] No Butterbase auth — skipping DB persistence");
    }

    // ── 1. Connect to RocketRide ────────────────────────────────────
    const token = await this.rocketride.connect();
    console.log(`[Preprocessor] RocketRide ready — token=${token}`);

    // ── 2. Initialise Spectrum ──────────────────────────────────────
    await this.messaging.init();

    // ── 3. Register message handler ─────────────────────────────────
    this.messaging.listen(async (msg) => {
      const userId = msg.user_id ?? this.options.defaultUserId ?? "anonymous";
      const convId = msg.conv_id ?? crypto.randomUUID();

      try {
        // ═══════════════════════════════════════════════════════════
        //  STEP A — Recall memories from XTrace
        // ═══════════════════════════════════════════════════════════
        const allGroupIds = [...this.categoryGroups.values()];
        const recallResult = await this.memory.recall(msg.content, userId, allGroupIds);
        console.log(
          `[Preprocessor] XTrace recall — ${recallResult.prompt.length} chars across ${allGroupIds.length} groups`,
        );

        // ═══════════════════════════════════════════════════════════
        //  STEP B — Run RocketRide pipeline (LLM reasoning + tools)
        // ═══════════════════════════════════════════════════════════
        const q = new Question({ expectJson: false });
        q.addQuestion(msg.content);
        if (recallResult.prompt) {
          q.addContext(recallResult.prompt);
        }
        const pipelineResult = await this.rocketride.chat(q);
        const pipelineReply = pipelineResult.text;
        console.log(`[Preprocessor] RocketRide done — ${pipelineReply.length} chars`);

        // ═══════════════════════════════════════════════════════════
        //  STEP C — Spawn embedded web-use pi agent for browsing
        // ═══════════════════════════════════════════════════════════
        const webResult = await this.webUse.browse({
          task: msg.content,
          browser: this.options.browser ?? undefined,
          // Pass XTrace memory context so the agent knows past facts
          memoryContext: recallResult.prompt,
          // Pass XTrace functions for recall/ingest during browse
          recall: (query, uid) => this.memory.recall(query, uid, allGroupIds),
          ingest: (messages, uid, cid, gids) => this.memory.ingestMessages(messages, uid, cid, gids ?? allGroupIds),
          userId,
          convId,
        });
        console.log(
          `[Preprocessor] WebUseAgent done — ${webResult.answer.length} chars (${webResult.durationMs}ms)`,
        );

        const finalAnswer = webResult.success
          ? webResult.answer
          : pipelineReply;

        // ═══════════════════════════════════════════════════════════
        //  STEP D — Classify and persist
        // ═══════════════════════════════════════════════════════════
        const category = await this._classify(finalAnswer);
        const groupId = this.categoryGroups.get(category) ?? this.categoryGroups.get("other") ?? "web-other";

        // D1. Ingest conversation into XTrace
        await this.memory.ingestMessages(
          [msg, { role: "assistant", content: finalAnswer }],
          userId,
          convId,
          [groupId],
        );
        console.log(`[Preprocessor] XTrace ingested → group ${category} (${groupId})`);

        // D2. Save session to Butterbase DB
        if (this.backend.isAuthenticated) {
          await this.backend.insertSession({
            user_id: userId,
            query_text: msg.content,
            category,
            reply_text: finalAnswer,
          });
          console.log("[Preprocessor] Butterbase session saved");
        }

        return finalAnswer;
      } catch (err) {
        console.error("[Preprocessor] Error:", err);
        return "Sorry, I encountered an error processing your request.";
      }
    });

    console.log("[Preprocessor] Agent loop running.");
  }

  async shutdown(): Promise<void> {
    await this.rocketride.disconnect();
    await this.messaging.shutdown();
  }

  private async _classify(text: string): Promise<Category> {
    if (!this.backend.isAuthenticated) return "other";
    try {
      const label = await this.backend.classifyText(text);
      const names = CATEGORY_DEFS.map((d) => d.name) as string[];
      return (names.includes(label) ? label : "other") as Category;
    } catch {
      return "other";
    }
  }
}
