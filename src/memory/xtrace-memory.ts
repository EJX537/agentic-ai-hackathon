/**
 * XTrace Memory SDK — Long-Term Memory for AI Agents
 *
 * Send conversation messages, get back structured facts you can search.
 * Supports ingest, semantic search, recall (personal + group union), and
 * Vercel AI SDK integration.
 *
 * Docs: https://docs.xtrace.ai
 * SDK: @xtraceai/memory on npm
 */
import { MemoryClient } from "@xtraceai/memory";
import { config } from "../config/env.ts";
import type { MemoryFact, Message } from "../types/index.ts";

/** XTrace only allows user/assistant/system roles (no "tool"). */
type XTraceRole = "user" | "assistant" | "system";

/** Narrow our Message to the subset XTrace accepts. */
function toXTraceMessages(msgs: Message[]): Array<{ role: XTraceRole; content: string }> {
  return msgs.map((m) => ({
    role: (m.role === "tool" ? "assistant" : m.role) as XTraceRole,
    content: m.content,
  }));
}

export class MemoryService {
  private client: MemoryClient;

  constructor() {
    this.client = new MemoryClient({
      apiKey: config.xtrace.apiKey,
      orgId: config.xtrace.orgId,
    });
  }

  /**
   * Ingest a conversation turn into long-term memory.
   * Extraction runs async by default; set `wait: true` for synchronous ingestion.
   */
  async ingestMessages(messages: Message[], userId: string, convId: string): Promise<number> {
    const result = await this.client.memories.ingest(
      {
        messages: toXTraceMessages(messages),
        user_id: userId,
        conv_id: convId,
      },
      { wait: true },
    );

    // `memories_created` is MemoryRef[]; return count
    return result.result?.memories_created.length ?? 0;
  }

  /**
   * Semantic search over a user's stored memories.
   */
  async searchMemories(query: string, userId: string): Promise<MemoryFact[]> {
    const results = await this.client.memories.search({
      query,
      user_id: userId,
    });

    return results.data.map((m) => ({
      id: m.id,
      text: m.text,
      type: m.type as MemoryFact["type"],
      createdAt: m.created_at,
      score: m.score ?? undefined,
    }));
  }

  /**
   * Personal + shared (group) recall in one call.
   * Unifies the user's own memories with shared group knowledge.
   */
  async recall(
    query: string,
    userId: string,
    groupIds?: string[],
  ): Promise<{ prompt: string }> {
    const pools: Array<{ user_id?: string; group_ids?: string[] }> = [
      { user_id: userId },
    ];
    if (groupIds && groupIds.length > 0) {
      pools.push({ group_ids: groupIds });
    }

    return this.client.memories.recall({ query, pools });
  }

  /**
   * List all memories for a user (auto-paginated).
   */
  async *listMemories(userId: string): AsyncGenerator<MemoryFact> {
    for await (const memory of this.client.memories.list({ user_id: userId })) {
      yield {
        id: memory.id,
        text: memory.text,
        type: memory.type as MemoryFact["type"],
        createdAt: memory.created_at,
      };
    }
  }

  /**
   * Delete a specific memory by ID.
   */
  async deleteMemory(id: string): Promise<void> {
    await this.client.memories.delete(id);
  }
}
