/**
 * Agent Orchestrator — Combines all six services into a unified agent loop.
 *
 * Flow:
 *   1. Receive message (via Spectrum)
 *   2. Recall relevant memories (via XTrace)
 *   3. Run AI pipeline with enriched context (via RocketRide — CORE)
 *   4. Persist new memories (via XTrace)
 *   5. Store results / state (via Butterbase)
 *   6. Reply through messaging (via Spectrum)
 *
 * RocketRide is the execution core: every agent action is a pipeline run.
 * The pipeline can invoke LLMs, vector search, OCR, or any of the 50+ nodes.
 */
import { RocketRideService, type PipelineOptions, type SendOptions } from "../pipelines/ai-pipeline.ts";
import { MessagingService } from "../messaging/spectrum.ts";
import { MemoryService } from "../memory/xtrace-memory.ts";
import { BackendService } from "../backend/butterbase.ts";
import type { AgentContext, Message } from "../types/index.ts";

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

export class AgentOrchestrator {
  /** RocketRide is the execution core — every agent action flows through it. */
  private rocketride: RocketRideService;
  private messaging: MessagingService;
  private memory: MemoryService;
  private backend: BackendService;
  private options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.rocketride = new RocketRideService(options.pipeline);
    this.messaging = new MessagingService();
    this.memory = new MemoryService();
    this.backend = new BackendService();
    this.options = options;
  }

  /**
   * Start the full agent loop: connect to RocketRide, initialise services,
   * listen for messages, process each one through the pipeline, and reply.
   */
  async start(): Promise<void> {
    console.log("[AgentOrchestrator] Starting...");

    // ── 0. Connect to RocketRide (the core execution engine) ──────────
    const token = await this.rocketride.connect();
    console.log(`[AgentOrchestrator] RocketRide ready — token=${token}`);

    // ── 1. Initialise Spectrum messaging ──────────────────────────────
    await this.messaging.init();

    // ── 2. Register the message handler ───────────────────────────────
    this.messaging.listen(async (msg) => {
      const userId =
        msg.user_id ?? this.options.defaultUserId ?? "anonymous";
      const convId = msg.conv_id ?? crypto.randomUUID();

      // Build agent context with memory recall
      const context: AgentContext = {
        userId,
        conversationId: convId,
        recentMessages: [msg],
        recalledMemories: [],
      };

      try {
        // ── 3. Recall relevant memories ──────────────────────────────
        context.recalledMemories = await this.memory.searchMemories(
          msg.content,
          userId,
        );
        const memoryContext = context.recalledMemories
          .map((m) => `[${m.type}] ${m.text}`)
          .join("\n");

        // ── 4. Run the RocketRide pipeline with enriched context ─────
        const sendOpts: SendOptions = {
          text: msg.content,
          context: {
            memories: memoryContext,
            userId,
            conversationId: convId,
          },
        };

        const result = await this.rocketride.send(sendOpts);

        // Extract the output string from the pipeline result
        const replyText = extractReply(result.output);

        // ── 5. Persist the interaction as new memories ────────────────
        await this.memory.ingestMessages(
          [
            msg,
            { role: "assistant", content: replyText },
          ],
          userId,
          convId,
        );

        // ── 6. Store state in Butterbase (if app ID configured) ──────
        if (this.options.butterbaseAppId) {
          await this.backend.kvSet(
            this.options.butterbaseAppId,
            `conv:${convId}`,
            {
              userId,
              messages: [
                msg,
                { role: "assistant", content: replyText },
              ],
              pipelineResult: {
                durationMs: result.durationMs,
                pipelineId: result.pipelineId,
              },
            },
            86400, // 24h TTL
          );
        }

        return replyText;
      } catch (err) {
        console.error(
          "[AgentOrchestrator] Error processing message:",
          err,
        );
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
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Extract a string reply from the RocketRide pipeline output.
 * The result shape varies by pipeline config; we handle common cases.
 */
function extractReply(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (Array.isArray(output)) {
    return output.map(extractReply).join("\n");
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // Common result fields from chat/processing pipelines
    return String(
      obj.answer ?? obj.text ?? obj.output ?? obj.result ?? obj.content ?? JSON.stringify(obj),
    );
  }
  return String(output);
}
