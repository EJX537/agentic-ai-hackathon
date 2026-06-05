/**
 * Agent Orchestrator — Combines all four services into a unified agent loop.
 *
 * Flow:
 *   1. Receive message (via Spectrum)
 *   2. Recall relevant memories (via XTrace)
 *   3. Run AI pipeline with enriched context (via RocketRide)
 *   4. Persist new memories (via XTrace)
 *   5. Store results / state (via Butterbase)
 *   6. Reply through messaging (via Spectrum)
 */
import { RocketRideClient } from "../pipelines/ai-pipeline.ts";
import { MessagingService } from "../messaging/spectrum.ts";
import { MemoryService } from "../memory/xtrace-memory.ts";
import { BackendService } from "../backend/butterbase.ts";
import type { AgentContext, Message } from "../types/index.ts";

export interface OrchestratorOptions {
  /** RocketRide pipeline ID to invoke for the core AI logic */
  pipelineId: string;
  /** Default user ID fallback */
  defaultUserId?: string;
  /** XTrace group IDs for shared memory recall */
  memoryGroupIds?: string[];
  /** Butterbase app ID for state persistence */
  butterbaseAppId?: string;
}

export class AgentOrchestrator {
  private rocketride: RocketRideClient;
  private messaging: MessagingService;
  private memory: MemoryService;
  private backend: BackendService;
  private options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.rocketride = new RocketRideClient();
    this.messaging = new MessagingService();
    this.memory = new MemoryService();
    this.backend = new BackendService();
    this.options = options;
  }

  /**
   * Start the full agent loop: initialise services, listen for messages,
   * process each one through the pipeline, and reply.
   */
  async start(): Promise<void> {
    console.log("[AgentOrchestrator] Starting...");

    // Initialise Spectrum messaging
    await this.messaging.init();

    // Register the message handler
    this.messaging.listen(async (msg) => {
      const userId = msg.user_id ?? this.options.defaultUserId ?? "anonymous";
      const convId = msg.conv_id ?? crypto.randomUUID();

      // 1. Build agent context with memory recall
      const context: AgentContext = {
        userId,
        conversationId: convId,
        recentMessages: [msg],
        recalledMemories: [],
      };

      try {
        // 2. Recall relevant memories
        const recallResult = await this.memory.recall(
          msg.content,
          userId,
          this.options.memoryGroupIds,
        );
        context.recalledMemories = await this.memory.searchMemories(
          msg.content,
          userId,
        );

        // 3. Run the AI pipeline with enriched context
        const result = await this.rocketride.runPipeline(
          this.options.pipelineId,
          {
            message: msg.content,
            memories: recallResult.prompt,
            userId,
            conversationId: convId,
          },
        );

        // 4. Persist the interaction as new memories
        await this.memory.ingestMessages(
          [
            msg,
            { role: "assistant", content: String(result.output) },
          ],
          userId,
          convId,
        );

        // 5. Store state in Butterbase (if app ID configured)
        if (this.options.butterbaseAppId) {
          await this.backend.kvSet(
            this.options.butterbaseAppId,
            `conv:${convId}`,
            {
              userId,
              messages: [msg, { role: "assistant", content: result.output }],
              pipelineResult: result,
            },
            86400, // 24h TTL
          );
        }

        // Return the pipeline output as the reply
        return String(result.output);
      } catch (err) {
        console.error("[AgentOrchestrator] Error processing message:", err);
        return "Sorry, I encountered an error processing your message.";
      }
    });

    console.log("[AgentOrchestrator] Agent loop running.");
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    await this.messaging.shutdown();
  }
}
