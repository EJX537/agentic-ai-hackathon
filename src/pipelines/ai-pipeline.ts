/**
 * RocketRide — AI Pipeline Engine Integration
 *
 * RocketRide is a high-performance AI pipeline engine with a C++ core
 * and 50+ nodes covering LLMs, vector DBs, OCR, and agent orchestration.
 *
 * Docs: https://docs.rocketride.org
 * TS SDK: https://www.npmjs.com/package/rocketride
 */
import { config } from "../config/env.ts";
import type { PipelineResult } from "../types/index.ts";

export class RocketRideClient {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = config.rocketride.apiUrl;
    this.apiKey = config.rocketride.apiKey;
  }

  /**
   * Run a pipeline by its ID with the given input payload.
   * Pipeline definitions (.pipe files) are created visually or programmatically.
   */
  async runPipeline(
    pipelineId: string,
    input: Record<string, unknown>,
  ): Promise<PipelineResult> {
    const start = performance.now();

    const res = await fetch(`${this.baseUrl}/pipelines/${pipelineId}/run`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ input }),
    });

    if (!res.ok) {
      throw new Error(
        `RocketRide pipeline ${pipelineId} failed: ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      output: unknown;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      pipelineId,
      output: data.output,
      durationMs: Math.round(performance.now() - start),
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * List available pipelines on the connected RocketRide server.
   */
  async listPipelines(): Promise<Array<{ id: string; name: string; nodes: number }>> {
    const res = await fetch(`${this.baseUrl}/pipelines`, {
      headers: this.headers(),
    });

    if (!res.ok) {
      throw new Error(`Failed to list pipelines: ${res.status}`);
    }

    return res.json() as Promise<Array<{ id: string; name: string; nodes: number }>>;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }
}
