/**
 * XTrace Memory SDK — Long-Term Memory for AI Agents
 *
 * Send conversation messages, get back structured facts you can search.
 * Supports ingest (with group tagging), semantic search, recall (personal +
 * group union), group registration, and Vercel AI SDK integration.
 *
 * Groups let the ingest-time classifier tag each extracted memory with the
 * categories it belongs to (food, travel, tech, …). Register a group before
 * passing its id in `ingestMessages()` or `recall()`.
 *
 * Docs: https://docs.xtrace.ai
 * SDK: @xtraceai/memory on npm
 */
import { MemoryClient } from "@xtraceai/memory";
import type { GroupCreateRequest } from "@xtraceai/memory";
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

  // ═══════════════════════════════════════════════════════════════════
  //  GROUPS — Register category groups for memory tagging
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register a memory group for categorising ingested content.
   *
   * The `prompt` tells the classifier what kind of content belongs to this
   * group. Example:
   *   name: "food"
   *   prompt: "Restaurants, recipes, ingredients, dining experiences, and food reviews"
   *
   * Groups must exist before their ids are passed to `ingestMessages()` or
   * `recall()`.  Registration is idempotent — registering the same name
   * twice may return the existing group (server behaviour depends on the
   * provider tier).
   *
   * Returns the registered group as `{ id, name, prompt }`.
   */
  async registerGroup(body: GroupCreateRequest): Promise<{ id: string; name: string }> {
    const group = await this.client.groups.create(body);
    console.log(`[XTrace] Group registered: "${body.name}" → ${group.id}`);
    return { id: group.id, name: group.name };
  }

  /**
   * Register multiple groups at once.
   */
  async registerGroups(
    groups: GroupCreateRequest[],
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    for (const g of groups) {
      const { id } = await this.registerGroup(g);
      results.set(g.name, id);
    }
    return results;
  }

  /**
   * List all registered groups for the org.
   */
  async listGroups(): Promise<Array<{ id: string; name: string; prompt: string }>> {
    const groups = await this.client.groups.list();
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      prompt: g.prompt,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INGEST — Write conversations to long-term memory
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Ingest a conversation turn into long-term memory.
   *
   * When `groupIds` are provided, the ingest-time classifier tags each
   * extracted memory with the subset of groups it matches.  Call
   * `registerGroup()` / `registerGroups()` first so the ids are valid.
   *
   * Extraction runs async by default; set `wait: true` for synchronous
   * ingestion.
   */
  async ingestMessages(
    messages: Message[],
    userId: string,
    convId: string,
    groupIds?: string[],
  ): Promise<number> {
    const result = await this.client.memories.ingest(
      {
        messages: toXTraceMessages(messages),
        user_id: userId,
        conv_id: convId,
        group_ids: groupIds,
      },
      { wait: true },
    );

    const created = result.result?.memories_created.length ?? 0;

    if (groupIds && groupIds.length > 0) {
      const ignored = result.result?.ignored_group_ids;
      if (ignored && ignored.length > 0) {
        console.warn(
          `[XTrace] ${ignored.length} group id(s) ignored by server — unknown/archived: ${ignored.join(", ")}`,
        );
      }
    }

    return created;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SEARCH / RECALL — Read from long-term memory
  // ═══════════════════════════════════════════════════════════════════

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
   *
   * Unifies the user's own memories with shared group knowledge by
   * searching each scope pool in parallel, deduplicating by id, and
   * re-ranking by score into a ready-to-inject prompt.
   *
   * @param query  The search query (semantic, not keyword).
   * @param userId  Scope search to this user's personal memories.
   * @param groupIds  Additional scope — shared memories tagged with these groups.
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

  // ═══════════════════════════════════════════════════════════════════
  //  ADMIN
  // ═══════════════════════════════════════════════════════════════════

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
