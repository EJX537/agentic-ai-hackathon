/**
 * Shared types used across the application.
 */

/** A generic message shape shared between pipeline, memory, and messaging. */
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Optional tool-call identifier when role is "tool". */
  tool_call_id?: string;
  /** Optional conversation / thread identifier. */
  conv_id?: string;
  /** Optional user identifier for memory scoping. */
  user_id?: string;
}

/** Result of running an AI pipeline. */
export interface PipelineResult {
  pipelineId: string;
  output: unknown;
  durationMs: number;
  /** Token usage stats if available. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** A memory fact returned by XTrace. */
export interface MemoryFact {
  id: string;
  text: string;
  type: "fact" | "artifact" | "episode";
  createdAt: string;
  score?: number;
}

/** Agent context enriched with memory recall. */
export interface AgentContext {
  userId: string;
  conversationId: string;
  recentMessages: Message[];
  recalledMemories: MemoryFact[];
}
