/**
 * WebUseAgent — Embedded pi agent for web browsing with AX.
 *
 * Two-phase strategy:
 *   Phase 1: Search & Read — SearXNG + Trafilatura (fast, static content)
 *   Phase 2: Browse — Puppeteer + AX (JS-rendered / interactive pages)
 *
 * Connected to:
 *   - XTrace memory (recall context via prompt + remember_fact/recall_memory tools)
 *   - Butterbase AI Gateway (model provider)
 */
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { webUseTools, setToolContext, type ToolContext } from "./tools.ts";

export interface WebUseContext {
  /** The user's task/question */
  task: string;
  /** Starting URL to navigate to */
  startUrl?: string;
  /** Browser agent for web browsing */
  browser?: ToolContext["browser"];
  /** XTrace recall function (injected by orchestrator) */
  recall?: ToolContext["recall"];
  /** XTrace ingest function (injected by orchestrator) */
  ingest?: ToolContext["ingest"];
  /** Current user ID */
  userId?: string;
  /** Current conversation ID */
  convId?: string;
  /** Relevant XTrace memory context to inject into the prompt */
  memoryContext?: string;
}

export interface WebUseResult {
  /** The final answer/summary from the agent */
  answer: string;
  /** Whether the agent completed successfully */
  success: boolean;
  /** Duration in ms */
  durationMs: number;
}

export class WebUseAgent {
  private authStorage = AuthStorage.create();
  private modelRegistry = ModelRegistry.create(this.authStorage);

  /**
   * Run a web use session: spawn an embedded pi agent with browser tools
   * and let it browse to accomplish the task.
   */
  async browse(ctx: WebUseContext): Promise<WebUseResult> {
    const start = performance.now();

    // Wire up tool context (shared mutable state for tool execution)
    setToolContext({
      browser: ctx.browser ?? null,
      recall: ctx.recall,
      ingest: ctx.ingest,
      userId: ctx.userId,
      convId: ctx.convId,
    });

    // Find an available model
    const available = await this.modelRegistry.getAvailable();
    const model = available[0];
    if (model) {
      console.log(`[WebUseAgent] Using model: ${model.name ?? model.id}`);
    } else {
      console.warn("[WebUseAgent] No available models found");
    }

    // Create an in-memory pi agent session with NO built-in tools
    // (only our custom web use tools)
    const { session } = await createAgentSession({
      model,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      customTools: webUseTools,
    });

    let fullAnswer = "";

    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        fullAnswer += event.assistantMessageEvent.delta;
      }
    });

    try {
      const prompt = this.buildPrompt(ctx.task, ctx.startUrl, ctx.memoryContext);

      console.log(`[WebUseAgent] Prompting agent (${prompt.length} chars)...`);
      await session.prompt(prompt);
      // Wait for the agent to finish all tool calls
      await session.agent.waitForIdle();

      const duration = Math.round(performance.now() - start);
      console.log(`[WebUseAgent] Done in ${duration}ms (${fullAnswer.length} chars)`);

      // Extract the result from the final answer
      const resultMatch = fullAnswer.match(/## Result\n\n([\s\S]*)/);
      const answer = resultMatch?.[1]?.trim() || fullAnswer.trim() || "Task completed.";

      return {
        answer,
        success: fullAnswer.length > 0,
        durationMs: duration,
      };
    } catch (err) {
      const duration = Math.round(performance.now() - start);
      console.error(`[WebUseAgent] Error after ${duration}ms:`, err);
      return {
        answer: `Web use agent error: ${err}`,
        success: false,
        durationMs: duration,
      };
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  private buildPrompt(task: string, startUrl?: string, memoryContext?: string): string {
    const parts: string[] = [
      `You are a web use agent. Your job is to find information on the web to accomplish the user's task.`,
      ``,
      `## Task`,
      task,
      ``,
    ];

    // ── Inject XTrace memory context if available ──────────────────
    if (memoryContext) {
      parts.push(
        `## Context from Previous Sessions`,
        `The following is information the user has learned from previous browsing sessions:`,
        ``,
        memoryContext,
        ``,
        `Use this context to inform your research. You can also use recall_memory() to search for more.`,
        ``,
      );
    }

    parts.push(
      `## Two-Phase Approach`,
      ``,
      `### Phase 0: Memory`,
      `Before searching, use **recall_memory(query)** to check if relevant facts from past sessions exist.`,
      `At the end, use **remember_fact(fact)** to persist important findings.`,
      ``,
      `### Phase 1: Search & Read (preferred)`,
      `For MOST tasks, use this lightweight flow FIRST:`,
      ``,
      `1. **search_web(query, ...)** — Search the web with SearXNG. Start here!`,
      `   Be specific with queries. Try different angles if needed.`,
      `2. **read_url(urls)** — Read the full content of promising URLs from your search results.`,
      `3. Repeat search and read until you have enough information.`,
      `4. **done(summary)** — Call this when you have the answer.`,
      ``,
      `### Phase 2: Browse (escalation only)`,
      `If Phase 1 fails (JS-rendered pages, interactive content, Trafilatura returns empty), ESCALATE to:`,
      ``,
      `1. **navigate(url)** — Go to the page with Puppeteer (real browser).`,
      `2. **scan(maxNodes?)** — Scan with AX to see interactive elements.`,
      `3. **click(nodeId)** — Click buttons, links, toggles.`,
      `4. **fill(nodeId, value)** — Type into form fields.`,
      `5. **view(nodeId)** — Read a specific element's text.`,
      `6. **page_text()** — Get all visible text.`,
      `7. **screenshot()** — See visual layout (for vision models).`,
      `8. **done(summary)** — Return the final result.`,
      ``,
      `## When to Escalate to Browse`,
      `- read_url() returns "No content extracted" or very little content`,
      `- The page is clearly JS-heavy (SPA, web app, dashboard)`,
      `- You need to interact with forms, buttons, or search boxes`,
      `- The page has infinite scroll or lazy-loaded content`,
      ``,
      `## AX Tree Format (Phase 2)`,
      `The scan() output shows elements as a tree:`,
      `  [nodeId] <tagname> action:label`,
      `  - click: "Search" — clickable button`,
      `  - edit: "query"[text?] — text input`,
      `  - nav: "Pricing" — navigation link`,
      `  - view: "Heading" — readable content`,
      ``,
      `## Guidelines`,
      `- ALWAYS start with recall_memory() to check existing knowledge`,
      `- ALWAYS start with search_web() + read_url() — they are faster`,
      `- Only escalate to browse when search+read isn't enough`,
      `- Try 2-3 different search queries with different phrasings`,
      `- After browse actions, always scan() again to see the new page state`,
      `- Use remember_fact() before done() to persist important findings`,
      `- Use done() only when you have a complete answer`,
      ``,
      `Begin!`,
    );

    return parts.join("\n");
  }
}
