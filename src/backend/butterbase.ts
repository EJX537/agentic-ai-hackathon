/**
 * Butterbase — Open-Source Backend-as-a-Service Integration
 *
 * Postgres · Auth · Storage · Functions · AI Gateway · MCP
 * Butterbase provides the building blocks for AI-driven applications
 * without lock-in.
 *
 * Docs: https://github.com/butterbase-ai/butterbase
 * SDK: @butterbase/sdk on npm
 */
import { createClient } from "@butterbase/sdk";
import type { ButterbaseClient } from "@butterbase/sdk";
import { config } from "../config/env.ts";

export class BackendService {
  private client: ButterbaseClient;

  constructor() {
    // ButterbaseClient requires an appId — use a placeholder that callers
    // override per-operation, or set via env.
    this.client = createClient({
      appId: config.butterbase.apiUrl, // placeholder; real appId should be set per-context
      apiUrl: config.butterbase.apiUrl,
    });
  }

  /**
   * Access the underlying Butterbase client directly.
   */
  getClient(): ButterbaseClient {
    return this.client;
  }

  /**
   * Create a fresh client for a specific app.
   */
  forApp(appId: string): ButterbaseClient {
    return createClient({
      appId,
      apiUrl: config.butterbase.apiUrl,
    });
  }

  /**
   * Define a database schema for the app.
   * Schemas are Postgres-backed with row-level security.
   */
  async defineSchema(appId: string, schema: Record<string, unknown>) {
    return this.client.request("PUT", `/apps/${appId}/schema`, schema);
  }

  /**
   * Store a key-value pair (regional, TTL-supported, quota-enforced).
   */
  async kvSet(appId: string, key: string, value: unknown, ttlSeconds?: number) {
    return this.client.request("POST", `/v1/${appId}/kv/${key}`, {
      value,
      ttl: ttlSeconds,
    });
  }

  /**
   * Retrieve a key-value pair.
   */
  async kvGet(appId: string, key: string) {
    return this.client.request("GET", `/v1/${appId}/kv/${key}`);
  }

  /**
   * Invoke a serverless function by name.
   */
  async invokeFunction(appId: string, functionName: string, payload: unknown) {
    return this.client.request(
      "POST",
      `/apps/${appId}/functions/${functionName}/invoke`,
      payload,
    );
  }

  /**
   * Query the AI gateway — single endpoint for chat completions
   * across multiple providers.
   */
  async aiChat(
    appId: string,
    messages: Array<{ role: string; content: string }>,
    model?: string,
  ) {
    return this.client.request("POST", `/apps/${appId}/gateway/chat`, {
      messages,
      model: model ?? "gpt-4o",
    });
  }

  /**
   * Upload a file to object storage (S3/R2-backed).
   */
  async uploadFile(appId: string, file: Blob, path: string) {
    const form = new FormData();
    form.append("file", file, path);
    return this.client.request("POST", `/storage/${appId}/${path}`, form);
  }
}
