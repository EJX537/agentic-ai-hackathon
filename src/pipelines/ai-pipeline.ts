/**
 * RocketRide — AI Pipeline Engine (Core)
 *
 * RocketRide is a high-performance AI pipeline platform with a C++ engine
 * and 50+ nodes (LLMs, vector DBs, OCR, agent workflows).
 *
 * This module wraps the official RocketRide SDK's WebSocket/DAP protocol:
 *   connect → use() a pipeline → send/pipe/chat → terminate → disconnect
 *
 * SDK: rocketride@1.2.0 (npm)
 * Docs: https://docs.rocketride.org
 */
import {
  RocketRideClient as RRClient,
  Question,
  Answer,
} from "rocketride";
import type { PipelineConfig } from "rocketride";
import { config } from "../config/env.ts";
import type { PipelineResult } from "../types/index.ts";

/** Options used to look up or define the pipeline this agent runs. */
export interface PipelineOptions {
  /** Run a pipeline from a `.pipe` file path (Node only; path to JSON pipeline definition). */
  filepath?: string;
  /** Run an inline pipeline config object (works in both browser and Node). */
  pipeline?: PipelineConfig;
  /**
   * Server-side pipeline ID (persistent pipeline registered on the server).
   * Falls back to env `ROCKETRIDE_PIPELINE_ID`.
   */
  pipelineId?: string;
}

/**
 * Options passed to `send()` — the data payload for a pipeline run.
 */
export interface SendOptions {
  /** The user's message or input text. */
  text: string;
  /** Additional context (memories, metadata, etc.). */
  context?: Record<string, unknown>;
  /** MIME type of the payload (default: text/plain). */
  mimeType?: string;
  /** Descriptive object info for the pipeline (e.g. `{ name: "query.txt" }`). */
  objinfo?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Core RocketRide service — wraps the official SDK's WebSocket client.
 *
 * Usage:
 * ```ts
 * const rr = new RocketRideService({ filepath: "./agent.pipe" });
 * await rr.connect();
 * const result = await rr.send({ text: "hello", context: { memories: [...] } });
 * await rr.disconnect();
 * ```
 */
export class RocketRideService {
  private client: RRClient;
  private options: PipelineOptions;
  private taskToken: string | null = null;

  constructor(options: PipelineOptions = {}) {
    this.client = new RRClient({
      auth: config.rocketride.apiKey || undefined,
      uri: config.rocketride.apiUrl,
      persist: false,
      requestTimeout: 60_000,
      onConnected: async () => console.log("[RocketRide] Connected"),
      onDisconnected: async (reason, hasError) =>
        console.log(`[RocketRide] Disconnected: ${reason} (error=${hasError})`),
      onConnectError: (msg) => console.error("[RocketRide] Connection error:", msg),
    });
    this.options = options;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────

  /**
   * Connect to the RocketRide server and start the pipeline.
   * Returns the task token used for all subsequent operations.
   */
  async connect(): Promise<string> {
    await this.client.connect();
    const result = await this.client.use({
      filepath: this.options.filepath,
      pipeline: this.options.pipeline,
      ttl: 3600, // keep task alive for 1h
    });
    this.taskToken = result.token;
    console.log(`[RocketRide] Pipeline started — token=${result.token}`);
    return result.token;
  }

  /**
   * Disconnect the WebSocket and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.taskToken) {
      try {
        await this.client.terminate(this.taskToken);
      } catch {
        // ignore errors during shutdown
      }
      this.taskToken = null;
    }
    if (this.client.isConnected()) {
      await this.client.disconnect();
    }
  }

  // ── Single-shot data ──────────────────────────────────────────────────

  /**
   * Send data to the pipeline in one shot and return the result.
   *
   * For simple message-passing (the common case). Use `pipe()` for
   * streaming large payloads.
   */
  async send(options: SendOptions): Promise<PipelineResult> {
    if (!this.taskToken) throw new Error("Not connected. Call .connect() first.");

    const start = performance.now();
    const payload = options.context
      ? JSON.stringify({ text: options.text, ...options.context })
      : options.text;

    const result = await this.client.send(
      this.taskToken,
      payload,
      options.objinfo ?? { name: "agent-input.txt" },
      options.mimeType ?? "text/plain",
    );

    return {
      pipelineId: this.options.pipelineId ?? this.options.filepath ?? "inline",
      output: result,
      durationMs: Math.round(performance.now() - start),
    };
  }

  // ── Streaming data ────────────────────────────────────────────────────

  /**
   * Create a streaming pipe and push chunks to the pipeline.
   * Useful for large files or incremental data.
   */
  async pipe(
    chunks: AsyncIterable<Uint8Array> | Uint8Array[],
    objinfo?: Record<string, unknown>,
    mimeType?: string,
  ): Promise<PipelineResult> {
    if (!this.taskToken) throw new Error("Not connected. Call .connect() first.");

    const start = performance.now();
    const pipe = await this.client.pipe(
      this.taskToken,
      objinfo ?? { name: "stream.dat" },
      mimeType ?? "application/octet-stream",
    );

    await pipe.open();
    for await (const chunk of chunks) {
      await pipe.write(chunk);
    }
    const result = await pipe.close();

    return {
      pipelineId: this.options.pipelineId ?? "stream",
      output: result,
      durationMs: Math.round(performance.now() - start),
    };
  }

  // ── Chat (conversational AI) ──────────────────────────────────────────

  /**
   * Send a structured chat question to the pipeline.
   *
   * Use this when the pipeline is configured for conversational AI
   * (e.g., a chat-completion pipeline with instructions + history).
   */
  async chat(question: Question): Promise<PipelineResult> {
    if (!this.taskToken) throw new Error("Not connected. Call .connect() first.");

    const start = performance.now();
    const result = await this.client.chat({
      token: this.taskToken,
      question,
    });

    return {
      pipelineId: this.options.pipelineId ?? "chat",
      output: result,
      durationMs: Math.round(performance.now() - start),
    };
  }

  // ── Convenience builders ──────────────────────────────────────────────

  /**
   * Build a Question for the chat pipeline with instructions and history.
   */
  buildQuestion(text: string, history?: Array<{ role: string; content: string }>): Question {
    const q = new Question({ expectJson: false });
    q.addInstruction("Answer", "Respond clearly and concisely.");
    q.addQuestion(text);
    if (history) {
      for (const h of history) {
        q.addHistory(h);
      }
    }
    return q;
  }

  /**
   * Static helper: one-shot connect → send → disconnect.
   *
   * Perfect for running a single pipeline call without managing
   * the connection lifecycle manually.
   */
  static async runOnce(
    pipelineOptions: PipelineOptions,
    sendOptions: SendOptions,
  ): Promise<PipelineResult> {
    const service = new RocketRideService(pipelineOptions);
    await service.connect();
    try {
      return await service.send(sendOptions);
    } finally {
      await service.disconnect();
    }
  }

  // ── Status ────────────────────────────────────────────────────────────

  /**
   * Check if the WebSocket is connected.
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * Get the current pipeline task token.
   */
  getToken(): string | null {
    return this.taskToken;
  }

  /**
   * Get the underlying RocketRide client (for advanced use).
   */
  getClient(): RRClient {
    return this.client;
  }
}
