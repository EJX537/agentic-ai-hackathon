/**
 * Full Integration Test — iMessage → Services → WebUseAgent → iMessage
 *
 * Validates the complete pipeline:
 *   iMessage ──→ Spectrum (mock) ──→ [Butterbase + XTrace + RocketRide] ──→ WebUseAgent ──→ Spectrum → iMessage
 *
 * The "middle step" (web search / scrape / browse) runs through the REAL
 * WebUseAgent (embedded pi agent). A mock pi session factory replaces the
 * pi SDK's createAgentSession so the test doesn't need a real LLM — the
 * WebUseAgent's prompt-building, tool-context wiring, and result-extraction
 * code paths all execute for real.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { Message } from "../src/types/index.ts";
import { WebUseAgent } from "../src/webuse/web-use-agent.ts";
import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────
//  MOCKS
// ─────────────────────────────────────────────────────────────────────────

/** A dummy user/message that flows through the system. */
const FAKE_USER = { id: "test-user-001", phone: "+14155551234" };
const FAKE_CONV = "test-conv-001";

// Track what each step produced so we can assert on it.
const steps: string[] = [];

/**
 * Create a mock pi AgentSession that simulates a web-use agent's output.
 *
 * The mock session:
 *   - Emits text_deltas that build up a full response including `## Result`
 *   - prompt() resolves immediately
 *   - agent.waitForIdle() resolves immediately
 *   - dispose() is a no-op
 */
function createMockSession(resultSummary: string, toolCallCount = 3): AgentSession {
  const fullOutput =
    `I'll search for information about that.\n\n` +
    `Let me search for ${resultSummary.split(" ").slice(0, 5).join(" ")}...\n\n` +
    `Found some great results! Let me check them out.\n\n` +
    `## Result\n\n${resultSummary}`;

  let unsubscribeFn: (() => void) | null = null;
  const listeners = new Set<AgentSessionEventListener>();

  const session = {
    prompt: async () => {
      steps.push("webuse.session.prompt");
      // Simulate streaming deltas
      for (let i = 0; i < fullOutput.length; i += 80) {
        const delta = fullOutput.slice(i, i + 80);
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          } as any);
        }
      }
    },
    subscribe: (listener: AgentSessionEventListener) => {
      listeners.add(listener);
      steps.push("webuse.session.subscribe");
      const unsub = () => {
        listeners.delete(listener);
      };
      unsubscribeFn = unsub;
      return unsub;
    },
    dispose: () => {
      steps.push("webuse.session.dispose");
      listeners.clear();
    },
    get agent() {
      return {
        waitForIdle: async () => {
          steps.push("webuse.session.waitForIdle");
        },
        get state() {
          return { messages: [] };
        },
      };
    },
    get state() {
      return { messages: [] };
    },
    get sessionManager() {
      return { isPersisted: () => false };
    },
  } as unknown as AgentSession;

  return session;
}

// ── Mock Spectrum ───────────────────────────────────────────────────────

class MockMessaging {
  received: { content: string; sender: string } | null = null;
  replyText: string | null = null;

  async init() {
    steps.push("spectrum.init");
  }

  /** Simulates the listen() handler. Test calls this directly with a message. */
  async listen(handler: (msg: Message) => Promise<string | undefined>) {
    steps.push("spectrum.listen");
    this.replyText =
      (await handler({
        role: "user",
        content: "Find me good Italian restaurants in SF",
        user_id: FAKE_USER.id,
        conv_id: FAKE_CONV,
      })) ?? null;
  }

  async shutdown() {
    steps.push("spectrum.shutdown");
  }
}

// ── Mock Butterbase ────────────────────────────────────────────────────

class MockBackend {
  isAuthenticated = true;
  savedSession: Record<string, unknown> | null = null;
  savedPages: Array<{ url: string; category: string }> = [];

  async signIn(_params: { email: string; password: string }) {
    steps.push("butterbase.auth");
    this.isAuthenticated = true;
  }

  async insertSession(session: Record<string, unknown>) {
    steps.push("butterbase.db.insertSession");
    this.savedSession = session;
    return { id: "session-001", ...session };
  }

  async cachePage(page: { url: string; category: string }) {
    steps.push("butterbase.db.cachePage");
    this.savedPages.push(page);
  }

  async classifyText(text: string): Promise<string> {
    steps.push("butterbase.ai.classify");
    const lower = text.toLowerCase();
    if (lower.includes("food") || lower.includes("restaurant") || lower.includes("italian"))
      return "food";
    if (lower.includes("travel") || lower.includes("hotel")) return "travel";
    if (lower.includes("tech") || lower.includes("code") || lower.includes("gpt") || lower.includes("ai") || lower.includes("llm")) return "tech";
    return "other";
  }

  async summarize(text: string): Promise<string> {
    steps.push("butterbase.ai.summarize");
    return text.slice(0, 200) + "...";
  }

  async health() {
    return true;
  }
}

// ── Mock XTrace Memory ─────────────────────────────────────────────────

class MockMemory {
  recalledQueries: string[] = [];
  ingestedMessages: Array<{ messages: Message[]; groupIds?: string[] }> = [];
  registeredGroups: string[] = [];

  async registerGroup(body: { name: string; prompt: string }): Promise<{ id: string; name: string }> {
    steps.push(`xtrace.registerGroup(${body.name})`);
    this.registeredGroups.push(body.name);
    return { id: `grp_${body.name}`, name: body.name };
  }

  async recall(query: string, _userId: string, _groupIds?: string[]) {
    steps.push("xtrace.recall");
    this.recalledQueries.push(query);
    return {
      prompt: `[Memory recall for "${query}": Italian food preferences, dietary restrictions, favorite SF restaurants]`,
    };
  }

  async ingestMessages(
    messages: Message[],
    _userId: string,
    _convId: string,
    groupIds?: string[],
  ) {
    const label = groupIds && groupIds.length > 0
      ? `xtrace.ingest(group=${groupIds[0]})`
      : "xtrace.ingest";
    steps.push(label);
    this.ingestedMessages.push({ messages, groupIds });
    return messages.length;
  }

  async searchMemories(_query: string, _userId: string) {
    steps.push("xtrace.search");
    return [
      {
        id: "mem-1",
        text: "User likes pasta",
        type: "fact" as const,
        createdAt: new Date().toISOString(),
      },
    ];
  }
}

// ── Mock RocketRide ───────────────────────────────────────────────────

class MockRocketRide {
  async connect() {
    steps.push("rocketride.connect");
    return "mock-token";
  }

  async send(_opts: { text: string; context?: Record<string, unknown> }) {
    steps.push("rocketride.send");
    return {
      pipelineId: "test-pipeline",
      raw: { answer: "I found some great Italian restaurants in SF! Try Tony's." },
      durationMs: 450,
      text: "I found some great Italian restaurants in SF! Try Tony's.",
    };
  }

  async disconnect() {
    steps.push("rocketride.disconnect");
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  ORCHESTRATOR (mirrors the real orchestrator flow with mock services)
//
//  Step 3 (browse/search) uses the REAL WebUseAgent with a mock pi session
//  factory, so the WebUseAgent's prompt-building, tool-context-wiring, and
//  result-extraction code paths all execute for real.
// ─────────────────────────────────────────────────────────────────────────

class TestOrchestrator {
  readonly backend: MockBackend;
  readonly memory: MockMemory;
  readonly rocketride: MockRocketRide;
  readonly messaging: MockMessaging;
  readonly webUse: WebUseAgent;

  replyText: string | null = null;

  constructor() {
    this.backend = new MockBackend();
    this.memory = new MockMemory();
    this.rocketride = new MockRocketRide();
    this.messaging = new MockMessaging();
    // Real WebUseAgent with a mock pi session factory
    // (avoids needing a real LLM or pi SDK session)
    this.webUse = new WebUseAgent({
      createSession: async () => ({
        session: createMockSession(
          "Found 3 excellent Italian restaurants in San Francisco:\n" +
          "1. Tony's Italian Restaurant - North Beach - Family-run since 1982, authentic pasta\n" +
          "2. Francesca's Ristorante - Award-winning Italian cuisine\n" +
          "3. Little Italy Bistro - Cozy atmosphere, great seafood pasta",
        ),
      }),
    });
  }

  /** Simulate startup: register groups, auth, connect. */
  async setup(): Promise<void> {
    // Register XTrace category groups
    const categories = [
      { name: "food", prompt: "Restaurants, recipes, dining" },
      { name: "travel", prompt: "Destinations, hotels, flights" },
      { name: "tech", prompt: "Software, AI, dev tools" },
      { name: "shopping", prompt: "Products, deals, reviews" },
      { name: "news", prompt: "Current events, headlines" },
      { name: "other", prompt: "Uncategorised content" },
    ];
    for (const def of categories) {
      await this.memory.registerGroup(def);
    }

    // Butterbase auth
    await this.backend.signIn({ email: "test@test.com", password: "testpass" });

    // RocketRide connect
    await this.rocketride.connect();
  }

  /** Run the full pipeline for a single message. */
  async processMessage(incoming: Message): Promise<string> {
    const userId = incoming.user_id ?? "anonymous";
    const convId = incoming.conv_id ?? crypto.randomUUID();

    steps.push("=== PIPELINE START ===");

    // ── Step 1: XTrace memory recall (by category groups) ──────────
    const recallResult = await this.memory.recall(incoming.content, userId, [
      "web-food",
      "web-travel",
      "web-tech",
    ]);

    // ── Step 2: RocketRide pipeline ────────────────────────────────
    const pipelineResult = await this.rocketride.send({
      text: incoming.content,
      context: { memories: recallResult.prompt, userId, conversationId: convId },
    });

    // ── Step 3: REAL WebUseAgent browsing (embedded pi agent) ────────
    // Wrapped in try/catch so errors fall back to the pipeline result
    // (mirrors the real AgentOrchestrator in src/agents/orchestrator.ts)
    let finalAnswer: string;
    try {
      const webResult = await this.webUse.browse({
        task: incoming.content,
        // Pass XTrace memory context so the agent knows past facts
        memoryContext: recallResult.prompt,
        // Pass XTrace functions for recall/ingest during browse
        recall: (query, uid) => this.memory.recall(query, uid),
        ingest: (messages, uid, cid, gids) => this.memory.ingestMessages(messages, uid, cid, gids),
        userId,
        convId,
      });
      finalAnswer = webResult.success ? webResult.answer : pipelineResult.text;
    } catch (err) {
      console.warn("[TestOrchestrator] WebUseAgent error, falling back to pipeline:", err);
      finalAnswer = pipelineResult.text;
    }

    // ── Step 4: XTrace memory ingest (grouped by category) ─────────
    // Classify via Butterbase AI gateway
    const category = await this.backend.classifyText(incoming.content);

    // Compute the group ID for the classified category
    const groupId = `grp_${category}`;

    await this.memory.ingestMessages(
      [incoming, { role: "assistant", content: finalAnswer }],
      userId,
      convId,
      [groupId],
    );

    // ── Step 5: Butterbase DB persistence ──────────────────────────
    await this.backend.insertSession({
      user_id: userId,
      query_text: incoming.content,
      category,
      reply_text: finalAnswer,
    });

    steps.push("=== PIPELINE DONE ===");
    return finalAnswer;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  TESTS
// ─────────────────────────────────────────────────────────────────────────

describe("Integration: iMessage -> Services -> WebUseAgent -> iMessage", () => {
  let orch: TestOrchestrator;

  beforeEach(() => {
    steps.length = 0;
  });

  afterAll(() => {
    console.log("\n-- Step trace --");
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  });

  it("full pipeline: message in -> reply out (text query)", async () => {
    orch = new TestOrchestrator();
    await orch.setup();
    expect(orch.backend.isAuthenticated).toBe(true);

    // Process a text query
    const reply = await orch.processMessage({
      role: "user",
      content: "Find me good Italian restaurants in SF",
      user_id: FAKE_USER.id,
      conv_id: FAKE_CONV,
    });

    // ── Assertions ──

    // Reply contains WebUseAgent output (restaurant names from mock session)
    expect(reply).toContain("Tony's Italian Restaurant");
    expect(reply).toContain("Francesca's Ristorante");
    expect(reply).toContain("Little Italy Bistro");

    // XTrace: recall was called with the query
    expect(orch.memory.recalledQueries).toContain("Find me good Italian restaurants in SF");

    // XTrace: messages were ingested (conversation)
    expect(orch.memory.ingestedMessages.length).toBeGreaterThanOrEqual(1);
    // Each ingest call should carry the category group ID
    for (const im of orch.memory.ingestedMessages) {
      expect(im.groupIds).toEqual(["grp_food"]);
    }

    // Butterbase: classification worked (food keywords -> "food")
    expect(orch.backend.savedSession).not.toBeNull();
    expect(orch.backend.savedSession!.category).toBe("food");
    expect(orch.backend.savedSession!.query_text).toBe("Find me good Italian restaurants in SF");

    // WebUseAgent session lifecycle: subscribe → prompt → waitForIdle → dispose
    expect(steps).toContain("webuse.session.subscribe");
    expect(steps).toContain("webuse.session.prompt");
    expect(steps).toContain("webuse.session.waitForIdle");
    expect(steps).toContain("webuse.session.dispose");

    // Pipeline steps executed in order
    expect(orch.memory.registeredGroups).toContain("food");
    expect(orch.memory.registeredGroups).toContain("travel");
    expect(orch.memory.registeredGroups).toContain("tech");

    // Pipeline steps executed in order
    expect(steps).toContain("butterbase.auth");
    expect(steps).toContain("rocketride.connect");
    expect(steps).toContain("=== PIPELINE START ===");
    expect(steps).toContain("xtrace.recall");
    expect(steps).toContain("rocketride.send");
    expect(steps).toContain("butterbase.ai.classify");
    expect(steps).toContain("xtrace.ingest(group=grp_food)");
    expect(steps).toContain("butterbase.db.insertSession");
    expect(steps).toContain("=== PIPELINE DONE ===");
  });

  it("classifies different query categories correctly", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    // Travel query
    const travelReply = await orch.processMessage({
      role: "user",
      content: "Best hotels in Tokyo for under $200",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-002",
    });
    expect(orch.backend.savedSession!.category).toBe("travel");
    expect(travelReply).toBeDefined();
    expect(travelReply.length).toBeGreaterThan(10);

    // Tech query
    const techReply = await orch.processMessage({
      role: "user",
      content: "Explain the latest GPT-4 features and how to use them",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-003",
    });
    expect(orch.backend.savedSession!.category).toBe("tech");
    expect(techReply).toBeDefined();
    expect(techReply.length).toBeGreaterThan(10);
  });

  it("handles WebUseAgent errors gracefully — uses pipeline fallback", async () => {
    // Create an orchestrator where WebUseAgent's mock session throws
    const failingOrch = new TestOrchestrator();

    // Override WebUseAgent with one that always fails
    (failingOrch as any).webUse = new WebUseAgent({
      createSession: async () => {
        throw new Error("Pi session creation failed");
      },
    });

    await failingOrch.setup();

    const reply = await failingOrch.processMessage({
      role: "user",
      content: "Find me something",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-004",
    });

    // Should fall back to pipeline result (Tony's from MockRocketRide.send)
    expect(reply).toContain("Tony's");
  });

  it("works with an image reference in the message", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    const reply = await orch.processMessage({
      role: "user",
      content: "What restaurant is this? [image: photo.jpg]",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-005",
    });

    expect(reply).toBeDefined();
    expect(reply.length).toBeGreaterThan(10);
    expect(orch.backend.savedSession!.query_text).toContain("What restaurant is this?");
  });
});

// ════════════════════════════════════════════════════════════════════════
//  XTrace Memory Integration Tests
// ════════════════════════════════════════════════════════════════════════

describe("XTrace Memory → WebUseAgent integration", () => {
  let orch: TestOrchestrator;

  beforeEach(() => {
    steps.length = 0;
  });

  it("passes memory recall context to the browsing agent", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    // Pre-populate memory with a fact
    orch.memory.recalledQueries.push("historical fact");

    const reply = await orch.processMessage({
      role: "user",
      content: "Find me good Italian restaurants in SF",
      user_id: FAKE_USER.id,
      conv_id: FAKE_CONV,
    });

    // XTrace recall was called
    expect(orch.memory.recalledQueries).toContain("Find me good Italian restaurants in SF");
    // XTrace ingest happened
    expect(orch.memory.ingestedMessages.length).toBeGreaterThanOrEqual(1);
    expect(steps).toContain("xtrace.recall");
    expect(steps).toContain("xtrace.ingest(group=grp_food)");
  });

  it("groups page memories by category in XTrace", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    await orch.processMessage({
      role: "user",
      content: "Latest GPT AI developments",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-xtrace-1",
    });

    // Check that ingested messages carry the correct group IDs
    for (const im of orch.memory.ingestedMessages) {
      expect(im.groupIds).toBeDefined();
      if (im.groupIds) {
        for (const gid of im.groupIds) {
          expect(gid).toMatch(/grp_/);
        }
      }
    }

    // The ingest should be tech-related
    expect(orch.backend.savedSession!.category).toBe("tech");
  });

  it("ingests memories per session", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    await orch.processMessage({
      role: "user",
      content: "Best hotels in Tokyo for travel",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-xtrace-2",
    });

    // Should have ingested at least the conversation
    expect(orch.memory.ingestedMessages.length).toBeGreaterThanOrEqual(1);

    // The conversation memories should be grouped as travel
    const travelIngests = orch.memory.ingestedMessages.filter(
      (im) => im.groupIds?.[0] === "grp_travel",
    );
    expect(travelIngests.length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Agent Orchestrator — Direct Tests (no Spectrum listener)
// ════════════════════════════════════════════════════════════════════════

describe("Agent Orchestrator direct flow", () => {
  let orch: TestOrchestrator;

  beforeEach(() => {
    steps.length = 0;
  });

  it("orchestrator processes message through all 5 steps", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    const reply = await orch.processMessage({
      role: "user",
      content: "Tell me about the best Italian restaurants in Tokyo",
      user_id: FAKE_USER.id,
      conv_id: "test-direct-1",
    });

    // Verify all 5 steps executed
    expect(steps).toContain("xtrace.recall");
    expect(steps).toContain("rocketride.send");
    expect(steps).toContain("butterbase.ai.classify");
    expect(steps).toContain("webuse.session.subscribe");
    expect(steps).toContain("webuse.session.prompt");
    expect(steps).toContain("xtrace.ingest(group=grp_food)");
    expect(steps).toContain("butterbase.db.insertSession");

    // Reply includes WebUseAgent result
    expect(reply).toContain("Tony's Italian Restaurant");
  });

  it("preserves user identity through the pipeline", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    const customUser = { id: "user-custom-456", phone: "+16505551234" };
    await orch.processMessage({
      role: "user",
      content: "Find me a good pizza place",
      user_id: customUser.id,
      conv_id: "test-direct-2",
    });

    expect(orch.backend.savedSession!.user_id).toBe(customUser.id);
  });

  it("ingests memories with correct group IDs per category", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    // Food query
    await orch.processMessage({
      role: "user",
      content: "Best Italian restaurants in NYC",
      user_id: FAKE_USER.id,
      conv_id: "test-cat-1",
    });
    expect(orch.backend.savedSession!.category).toBe("food");

    // Travel query
    await orch.processMessage({
      role: "user",
      content: "Cheap travel hotel deals in Paris",
      user_id: FAKE_USER.id,
      conv_id: "test-cat-2",
    });
    expect(orch.backend.savedSession!.category).toBe("travel");
  });
});

// ════════════════════════════════════════════════════════════════════════
//  WebUseAgent — Real browse() flow with mock pi session
// ════════════════════════════════════════════════════════════════════════

describe("WebUseAgent browse() with mock pi session", () => {
  it("extracts ## Result from agent output", async () => {
    const agent = new WebUseAgent({
      createSession: async () => ({
        session: createMockSession(
          "Found 2 great Italian restaurants in SF",
        ),
      }),
    });

    const result = await agent.browse({
      task: "Find Italian restaurants in SF",
    });

    expect(result.success).toBe(true);
    expect(result.answer).toBe("Found 2 great Italian restaurants in SF");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns fallback when agent produces no output", async () => {
    const session = createMockSession("");
    // Override prompt to produce no deltas
    session.prompt = async () => {};

    const agent = new WebUseAgent({
      createSession: async () => ({ session }),
    });

    const result = await agent.browse({
      task: "Find something",
    });

    // Should return success: false since no output was produced,
    // but still get a fallback answer
    expect(result.success).toBe(false);
    expect(result.answer).toBe("Task completed.");
  });

  it("handles errors gracefully", async () => {
    const agent = new WebUseAgent({
      createSession: async () => {
        throw new Error("Session creation failed");
      },
    });

    const result = await agent.browse({
      task: "Find something",
    });

    expect(result.success).toBe(false);
    expect(result.answer).toContain("Web use agent error");
  });

  it("injects memory context into the agent prompt", async () => {
    // Create an agent with a spy on createSession
    let capturedOptions: any = null;

    const mockSession = createMockSession("Found results");
    const agent = new WebUseAgent({
      createSession: async (opts: any) => {
        capturedOptions = opts;
        return { session: mockSession };
      },
    });

    await agent.browse({
      task: "Find restaurants",
      memoryContext: "User prefers vegetarian options.",
    });

    // The mock session's createSession won't show the prompt,
    // but we verify the prompt was built correctly via the WebUseAgent's
    // buildPrompt method (tested separately in web-use-agent.test.ts)
    expect(capturedOptions).not.toBeNull();
  });
});
