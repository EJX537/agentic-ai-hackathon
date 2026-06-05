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
  type AgentSession,
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
  private createSession: typeof createAgentSession;

  constructor(opts?: { createSession?: typeof createAgentSession }) {
    // Allow dependency injection of createAgentSession so tests can provide a mock
    // without the real pi SDK (model, auth, etc.). Defaults to the real pi SDK.
    this.createSession = opts?.createSession ?? createAgentSession;
  }

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

    let fullAnswer = "";
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;

    try {
      console.log(`[WebUseAgent] browse() start — task:${ctx.task.length}c, memory:${ctx.memoryContext?.length ?? 0}c`);

      // Find an available model
      const available = await this.modelRegistry.getAvailable();
      console.log(`[WebUseAgent] Models available: ${available.length}`);
      const model = available[0];
      if (model) {
        console.log(`[WebUseAgent] Using model: ${model.name ?? model.id}`);
      } else {
        console.warn("[WebUseAgent] No available models found");
      }

      // Create an in-memory pi agent session with NO built-in tools
      // (only our custom web use tools)
      const result = await this.createSession({
        model,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        sessionManager: SessionManager.inMemory(),
        noTools: "builtin",
        customTools: webUseTools,
      });
      session = result.session;

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update") {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") {
            fullAnswer += e.delta;
          }
        } else if (event.type === "error") {
          console.error(`[WebUseAgent.error]`, event.error);
        }
      });

      const prompt = this.buildPrompt(ctx.task, ctx.startUrl, ctx.memoryContext);

      console.log(`[WebUseAgent] Prompting agent (${prompt.length} chars)...`);
      // Add a timeout to prevent hanging
      const promptPromise = session.prompt(prompt);
      const promptTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("session.prompt() timed out after 180s")), 180_000));
      
      // Log when prompt promise resolves vs timeout
      const promptResult = await Promise.race([
        promptPromise.then(() => ({ source: "prompt" })),
        promptTimeout.then(() => ({ source: "timeout" })),
      ]);
      console.log(`[WebUseAgent] prompt() completed (source: ${promptResult.source})`);
      // Log when idle promise resolves vs timeout
      const idlePromise = session.agent.waitForIdle();
      const idleTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("waitForIdle() timed out after 60s")), 60_000));
      
      const idleResult = await Promise.race([
        idlePromise.then(() => ({ source: "idle" })),
        idleTimeout.then(() => ({ source: "timeout" })),
      ]);
      console.log(`[WebUseAgent] waitForIdle() completed (source: ${idleResult.source})`);

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
      unsubscribe?.();
      session?.dispose();
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
      `## Available Tools`,
      `- search_web(query) — Web search via SearXNG`,
      `- read_url(urls) — Read page content`,
      `- navigate(url) — Go to a page with a real browser`,
      `- scan() — Scan with AX to see interactive elements`,
      `- click(nodeId) — Click buttons, links, toggles`,
      `- fill(nodeId, value) — Type into form fields`,
      `- view(nodeId) — Read a specific element's text`,
      `- page_text() — Get all visible text`,
      `- screenshot() — Take a screenshot`,
      `- done(summary) — Return final result`,
      ``,
      `## Guidelines`,
      `- After navigate() or click(), call scan() to see the new page state`,
      `- When you see a field you need to type into, use fill(nodeId, value)`,
      `- When you see a button you need to press, use click(nodeId)`,
      `- scan() shows: [nodeId] <tagname> action:label`,
      `- Be efficient — use scan() to find elements, then act on them directly`,
      `- Use done() with a complete summary when finished`,
      ``,
      `Begin!`,
    );

    return parts.join("\n");
  }
}
