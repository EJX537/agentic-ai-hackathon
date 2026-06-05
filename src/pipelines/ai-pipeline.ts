/**
 * RocketRide — AI Pipeline Engine (Core)
 *
 * RocketRide is a high-performance AI pipeline platform with a C++ engine
 * and 50+ nodes (LLMs, vector DBs, OCR, agent workflows, RAG, etc.).
 *
 * This module wraps the official RocketRide SDK's WebSocket/DAP protocol
 * and covers ALL data ingestion paths:
 *
 *   ├─ send()        — one-shot string/Uint8Array (small payloads)
 *   ├─ pipe()        — streaming chunks (large files, real-time data)
 *   ├─ sendFiles()   — multi-file parallel upload (browser File objects)
 *   ├─ chat()        — conversational AI with Question/Answer builder
 *   └─ monitor()     — real-time pipeline event subscription
 *
 * SDK: rocketride@1.2.0 (npm)
 * Docs: https://docs.rocketride.org
 */
import {
  RocketRideClient as RRClient,
  Question,
  Answer,
  type PipelineConfig,
  type PIPELINE_RESULT,
  type UPLOAD_RESULT,
  type TASK_STATUS,
  type QuestionHistory,
  type QuestionExample,
  type Doc,
  type DocFilter,
  type DAPMessage,
  type ServicesResponse,
} from "rocketride";
import { config } from "../config/env.ts";

// ── Re-export key types for consumers ────────────────────────────────
export type {
  PipelineConfig,
  PIPELINE_RESULT,
  UPLOAD_RESULT,
  TASK_STATUS,
  Doc,
  DocFilter,
  ServicesResponse,
};
export type QHistory = QuestionHistory;
export type QExample = QuestionExample;
export { Question, Answer };

/** Options used to look up or define the pipeline this agent runs. */
export interface PipelineOptions {
  /** Run a pipeline from a `.pipe` file path (JSON pipeline definition). */
  filepath?: string;
  /** Run an inline pipeline config object. */
  pipeline?: PipelineConfig;
  /**
   * Server-side pipeline ID (persistent pipeline registered on the server).
   * Falls back to env `ROCKETRIDE_PIPELINE_ID`.
   */
  pipelineId?: string;
}

/** Options passed to `send()` — the data payload for a pipeline run. */
export interface SendOptions {
  /** The user's message or input text. */
  text: string;
  /** Additional context (memories, metadata, etc.). */
  context?: Record<string, unknown>;
  /** MIME type of the payload (default: text/plain). */
  mimeType?: string;
  /** Descriptive object info (e.g. `{ name: "query.txt" }`). */
  objinfo?: Record<string, unknown>;
}

/** Result of a pipeline data operation, normalised for the agent layer. */
export interface IngestionResult {
  pipelineId: string;
  /** The raw response from the RocketRide server. */
  raw: unknown;
  /** Duration of the operation in ms. */
  durationMs: number;
  /** Normalised string extract for downstream use. */
  text: string;
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Core RocketRide service — wraps the official SDK's WebSocket client
 * and exposes all five data ingestion paths.
 */
export class RocketRideService {
  private client: RRClient;
  private options: PipelineOptions;
  private taskToken: string | null = null;
  private _startTime = 0;

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
      onEvent: async (event) => this._handleEvent(event),
    });
    this.options = options;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  1. CONNECTION LIFECYCLE
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Connect to the RocketRide server and start the pipeline.
   * Returns the task token used for all subsequent data operations.
   */
  async connect(): Promise<string> {
    this._startTime = performance.now();
    await this.client.connect();
    const result = await this.client.use({
      filepath: this.options.filepath,
      pipeline: this.options.pipeline,
      ttl: 3600,
      useExisting: true,
    });
    this.taskToken = result.token;
    console.log(`[RocketRide] Pipeline started — token=${this.taskToken}`);
    return this.taskToken;
  }

  /**
   * Connect and authenticate without starting a pipeline.
   * Useful when you need to browse services or templates first.
   */
  async connectOnly(): Promise<void> {
    await this.client.connect();
  }

  /**
   * Start a pipeline on an already-connected session.
   */
  async startPipeline(options?: {
    filepath?: string;
    pipeline?: PipelineConfig;
    ttl?: number;
  }): Promise<string> {
    const result = await this.client.use({
      filepath: options?.filepath ?? this.options.filepath,
      pipeline: options?.pipeline ?? this.options.pipeline,
      ttl: options?.ttl ?? 3600,
    });
    this.taskToken = result.token;
    return this.taskToken;
  }

  /**
   * Disconnect the WebSocket and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.taskToken) {
      try {
        await this.client.terminate(this.taskToken);
      } catch {
        // ignore during shutdown
      }
      this.taskToken = null;
    }
    if (this.client.isConnected()) {
      await this.client.disconnect();
    }
  }

  /**
   * Probe a server for capabilities without authenticating.
   */
  static async probeServer(uri: string): Promise<{
    version: string;
    capabilities: string[];
    platform: string;
  }> {
    return RRClient.getServerInfo(uri) as Promise<any>;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  2. ONE-SHOT DATA — send()
  //     Best for: short text, small JSON payloads, single strings
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Send data in a single request.
   *
   * The pipeline receives this as one complete input on the data lane.
   * Use this for small payloads (messages, queries, commands).
   *
   * If `context` is provided, it's JSON-serialised alongside `text` so
   * the pipeline receives a structured object.
   */
  async send(options: SendOptions): Promise<IngestionResult> {
    this._ensureConnected();

    const start = performance.now();
    const payload = options.context
      ? JSON.stringify({ text: options.text, ...options.context })
      : options.text;

    const result = await this.client.send(
      this.taskToken!,
      payload,
      options.objinfo ?? { name: "agent-input.txt" },
      options.mimeType ?? "text/plain",
    );

    return this._normaliseResult(result, Math.round(performance.now() - start));
  }

  // ═════════════════════════════════════════════════════════════════════
  //  3. STREAMING DATA — pipe()
  //     Best for: large files, real-time data feeds, incremental payloads
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Stream data through a pipe in chunks.
   *
   * Use this when data arrives incrementally — read a file in chunks,
   * receive real-time events, or concatenate multiple buffers.
   *
   * @example
   * ```ts
   * const chunks = [new TextEncoder().encode("chunk1"), new TextEncoder().encode("chunk2")];
   * const result = await rr.pipe(chunks, { name: "data.bin" }, "application/octet-stream");
   * ```
   */
  async pipe(
    chunks: AsyncIterable<Uint8Array> | Uint8Array[],
    objinfo?: Record<string, unknown>,
    mimeType?: string,
    onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>,
  ): Promise<IngestionResult> {
    this._ensureConnected();

    const start = performance.now();
    const pipe = await this.client.pipe(
      this.taskToken!,
      objinfo ?? { name: "stream.dat" },
      mimeType ?? "application/octet-stream",
      undefined,
      onSSE,
    );

    await pipe.open();
    for await (const chunk of chunks) {
      await pipe.write(chunk);
    }
    const result = await pipe.close();

    return this._normaliseResult(result, Math.round(performance.now() - start));
  }

  /**
   * Pipe text content as an encoded Uint8Array stream.
   * Convenience wrapper around `pipe()` for string data.
   */
  async pipeText(
    text: string,
    objinfo?: Record<string, unknown>,
    mimeType?: string,
  ): Promise<IngestionResult> {
    const encoder = new TextEncoder();
    return this.pipe([encoder.encode(text)], objinfo, mimeType ?? "text/plain");
  }

  // ═════════════════════════════════════════════════════════════════════
  //  4. MULTI-FILE UPLOAD — sendFiles()
  //     Best for: uploading multiple documents, images, or datasets
  //     Works with browser File objects (Blob) — parallel with progress
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Upload multiple files to the pipeline in parallel.
   *
   * Progress is reported through the `onEvent` callback as
   * `apaevt_status_upload` events.
   *
   * @example
   * ```ts
   * const files = [
   *   new File(["content"], "doc1.md", { type: "text/markdown" }),
   *   new File(["content"], "doc2.md", { type: "text/markdown" }),
   * ];
   * const results = await rr.sendFiles(files);
   * ```
   */
  async sendFiles(
    files: Array<{
      file: File;
      objinfo?: Record<string, unknown>;
      mimetype?: string;
    }>,
  ): Promise<UPLOAD_RESULT[]> {
    this._ensureConnected();

    const start = performance.now();
    const results = await this.client.sendFiles(files, this.taskToken!);
    console.log(
      `[RocketRide] sendFiles: ${results.filter((r) => r.action === "complete").length}/${results.length} done in ${Math.round(performance.now() - start)}ms`,
    );

    return results;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  5. CONVERSATIONAL AI — chat()
  //     Best for: multi-turn agent conversations with instructions,
  //     examples, context, history, and document references
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Send a structured Question to the pipeline for conversational AI.
   *
   * The pipeline must have a chat-compatible topology (e.g. Chat source →
   * Agent → LLM → Answer response).
   */
  async chat(question: Question): Promise<IngestionResult> {
    this._ensureConnected();

    const start = performance.now();
    const result = await this.client.chat({
      token: this.taskToken!,
      question,
    });

    return this._normaliseResult(result, Math.round(performance.now() - start));
  }

  /**
   * Quick chat helper: builds a Question, sends it, returns the answer string.
   */
  async ask(
    text: string,
    opts?: {
      instructions?: Array<{ title: string; instruction: string }>;
      history?: QHistory[];
      context?: string[];
      expectJson?: boolean;
    },
  ): Promise<string> {
    this._ensureConnected();

    const q = new Question({ expectJson: opts?.expectJson ?? false });
    q.addQuestion(text);

    if (opts?.instructions) {
      for (const inst of opts.instructions) {
        q.addInstruction(inst.title, inst.instruction);
      }
    }
    if (opts?.history) {
      for (const h of opts.history) q.addHistory(h);
    }
    if (opts?.context) {
      for (const c of opts.context) q.addContext(c);
    }

    const result = await this.client.chat({ token: this.taskToken!, question: q });
    const ing = this._normaliseResult(result, 0);
    return ing.text;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  6. MONITOR & EVENTS
  //     Subscribe to real-time pipeline execution events
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to specific pipeline event types.
   *
   * Events are delivered through the `onEvent` callback set in the constructor.
   * Common event types: 'summary', 'detail', 'flow', 'task', 'output', 'debugger'.
   */
  async addMonitor(
    key: { token: string } | { projectId: string; source: string },
    types: string[],
  ): Promise<void> {
    await this.client.addMonitor(key, types);
  }

  /**
   * Unsubscribe from specific pipeline event types.
   */
  async removeMonitor(
    key: { token: string } | { projectId: string; source: string },
    types: string[],
  ): Promise<void> {
    await this.client.removeMonitor(key, types);
  }

  /**
   * Poll the current task status (progress, errors, metrics).
   */
  async status(): Promise<TASK_STATUS | null> {
    if (!this.taskToken) return null;
    return this.client.getTaskStatus(this.taskToken);
  }

  /**
   * Poll status until the task completes.
   */
  async waitForCompletion(pollMs = 1000): Promise<TASK_STATUS> {
    while (true) {
      const s = await this.status();
      if (!s) throw new Error("Task not found");
      if (s.completed) return s;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  7. SERVICES & DISCOVERY
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Discover all available services/connectors on the server.
   */
  async getServices(): Promise<ServicesResponse> {
    return this.client.getServices();
  }

  /**
   * Get the definition for one service by name.
   */
  async getService(name: string): Promise<Record<string, unknown> | undefined> {
    return this.client.getService(name);
  }

  /**
   * Validate a pipeline config without running it.
   */
  async validate(pipeline: PipelineConfig): Promise<Record<string, unknown>> {
    return this.client.validate({ pipeline });
  }

  /**
   * Persist a pipeline as a named template.
   */
  async saveTemplate(templateId: string, pipeline: Record<string, unknown>): Promise<void> {
    return this.client.saveTemplate({ templateId, pipeline });
  }

  /**
   * List all saved pipeline templates.
   */
  async listTemplates(): Promise<
    Array<{ id: string; name: string; sources: unknown[]; totalComponents: number }>
  > {
    return this.client.getAllTemplates();
  }

  // ═════════════════════════════════════════════════════════════════════
  //  8. CONVENIENCE: ONE-SHOT PATTERN
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Static helper: one-shot connect → send → disconnect.
   */
  static async runOnce(
    pipelineOptions: PipelineOptions,
    sendOptions: SendOptions,
  ): Promise<IngestionResult> {
    const service = new RocketRideService(pipelineOptions);
    await service.connect();
    try {
      return await service.send(sendOptions);
    } finally {
      await service.disconnect();
    }
  }

  /**
   * Static helper: one-shot connect → chat → disconnect.
   */
  static async chatOnce(
    pipelineOptions: PipelineOptions,
    question: Question,
  ): Promise<IngestionResult> {
    const service = new RocketRideService(pipelineOptions);
    await service.connect();
    try {
      return await service.chat(question);
    } finally {
      await service.disconnect();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═════════════════════════════════════════════════════════════════════

  private _ensureConnected(): void {
    if (!this.taskToken)
      throw new Error("Not connected. Call .connect() or .startPipeline() first.");
  }

  private _normaliseResult(raw: unknown, durationMs: number): IngestionResult {
    return {
      pipelineId: this.options.pipelineId ?? this.options.filepath ?? "inline",
      raw,
      durationMs,
      text: extractReply(raw),
    };
  }

  private async _handleEvent(event: DAPMessage): Promise<void> {
    if (event.event === "apaevt_status_upload") {
      const body = event.body as Record<string, unknown> | undefined;
      if (body) {
        console.log(
          `[RocketRide] Upload: ${body.filepath ?? "?"} — ${body.bytes_sent ?? 0}/${body.file_size ?? 0} bytes`,
        );
      }
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.client.isConnected();
  }

  getToken(): string | null {
    return this.taskToken;
  }

  getClient(): RRClient {
    return this.client;
  }
}

/**
 * Extract a string reply from the RocketRide pipeline output.
 */
export function extractReply(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output) return "";
  if (Array.isArray(output)) {
    return output.map(extractReply).join("\n");
  }
  const obj = output as Record<string, unknown>;
  return String(
    obj.answer ?? obj.text ?? obj.output ?? obj.result ?? obj.content ?? JSON.stringify(obj),
  );
}
