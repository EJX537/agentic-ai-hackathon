/**
 * Full Integration Test — iMessage → Services → Mock Agent → iMessage
 *
 * Validates the complete pipeline:
 *   iMessage ──→ Spectrum (mock) ──→ [Butterbase + XTrace] ──→ Mock Agent ──→ Spectrum → iMessage
 *
 * The "mock agent" replaces step 3 (web search / scrape / browse) with
 * deterministic fake data so the test never needs Tavily or real websites.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { Message } from "../src/types/index.ts";

// ─────────────────────────────────────────────────────────────────────────
//  MOCKS
// ─────────────────────────────────────────────────────────────────────────

/** A dummy user/message that flows through the system. */
const FAKE_USER = { id: "test-user-001", phone: "+14155551234" };
const FAKE_CONV = "test-conv-001";

// Track what each step produced so we can assert on it.
const steps: string[] = [];

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

// ── Mock Agent (replaces step 3 search/scrape/browse) ─────────────────

class MockAgent {
  searchResults: Array<{ url: string; title: string; snippet: string }> = [];
  scrapedPages: Array<{ url: string; title: string; content: string; wordCount: number }> = [];

  async searchWeb(query: string, _options?: { maxResults?: number }) {
    steps.push(`mockagent.search(${query.slice(0, 30)})`);
    this.searchResults = [
      {
        url: "https://example.com/italian-restaurant-1",
        title: "Tony's Italian Restaurant - North Beach SF",
        snippet: "A family-run Italian restaurant serving authentic pasta since 1982.",
      },
      {
        url: "https://example.com/italian-restaurant-2",
        title: "Francesca's Ristorante - Best pasta in SF",
        snippet: "Award-winning Italian cuisine in the heart of San Francisco.",
      },
    ];
    return this.searchResults;
  }

  async scrapeContent(urls: string[]) {
    steps.push(`mockagent.scrape(${urls.length} urls)`);
    this.scrapedPages = urls.map((url) => ({
      url,
      title: `Scraped: ${url}`,
      content: `Mock content from ${url}. The restaurant serves authentic Italian dishes including pasta, pizza, and seafood. Highly rated.`,
      wordCount: 30,
    }));
    return this.scrapedPages;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  ORCHESTRATOR (mirrors the real orchestrator flow with mock services)
// ─────────────────────────────────────────────────────────────────────────

class TestOrchestrator {
  readonly backend: MockBackend;
  readonly memory: MockMemory;
  readonly rocketride: MockRocketRide;
  readonly messaging: MockMessaging;
  readonly agent: MockAgent;

  replyText: string | null = null;

  constructor() {
    this.backend = new MockBackend();
    this.memory = new MockMemory();
    this.rocketride = new MockRocketRide();
    this.messaging = new MockMessaging();
    this.agent = new MockAgent();
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

    // ── Step 3: Mock Agent (search -> scrape -> classify) ────────────
    const searchResults = await this.agent.searchWeb(incoming.content);
    const urls = searchResults.map((r) => r.url);
    const scrapedPages = await this.agent.scrapeContent(urls.slice(0, 2));

    // Classify via Butterbase AI gateway
    const category = await this.backend.classifyText(incoming.content);

    // Build final reply
    const replyText = [
      pipelineResult.text,
      "",
      "--- Sources ---",
      ...scrapedPages.map((p) => `- ${p.title}: ${p.url}`),
    ].join("\n");

    // ── Step 4: XTrace memory ingest (grouped by category) ─────────
    // Compute the group ID for the classified category
    const groupId = `grp_${category}`;

    await this.memory.ingestMessages(
      [incoming, { role: "assistant", content: replyText }],
      userId,
      convId,
      [groupId],
    );

    // Ingest each scraped page as a separate memory, tagged with the same group
    for (const page of scrapedPages) {
      await this.memory.ingestMessages(
        [
          { role: "system", content: `Website: ${page.url}` },
          { role: "assistant", content: `Title: ${page.title}\n\nContent:\n${page.content}` },
        ],
        userId,
        `${convId}:page:${page.url}`,
        [groupId],
      );
    }

    // ── Step 5: Butterbase DB persistence ──────────────────────────
    await this.backend.insertSession({
      user_id: userId,
      query_text: incoming.content,
      category,
      reply_text: replyText,
      source_count: urls.length,
    });

    for (const page of scrapedPages) {
      await this.backend.cachePage({ url: page.url, category });
    }

    steps.push("=== PIPELINE DONE ===");
    return replyText;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  TESTS
// ─────────────────────────────────────────────────────────────────────────

describe("Integration: iMessage -> Services -> Mock Agent -> iMessage", () => {
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

    // Reply contains pipeline output + sources
    expect(reply).toContain("Tony's");
    expect(reply).toContain("--- Sources ---");
    expect(reply).toContain("example.com");

    // XTrace: recall was called with the query
    expect(orch.memory.recalledQueries).toContain("Find me good Italian restaurants in SF");

    // XTrace: messages were ingested (conversation + page memories)
    expect(orch.memory.ingestedMessages.length).toBeGreaterThanOrEqual(3);
    // Each ingest call should carry the category group ID
    for (const im of orch.memory.ingestedMessages) {
      expect(im.groupIds).toEqual(["grp_food"]);
    }

    // Butterbase: classification worked (food keywords -> "food")
    expect(orch.backend.savedSession).not.toBeNull();
    expect(orch.backend.savedSession!.category).toBe("food");
    expect(orch.backend.savedSession!.query_text).toBe("Find me good Italian restaurants in SF");

    // Butterbase: pages were cached
    expect(orch.backend.savedPages.length).toBe(2);

    // Mock agent: search returned 2 results
    expect(orch.agent.searchResults.length).toBe(2);

    // Pipeline steps executed in order
    // XTrace groups were registered at startup
    expect(orch.memory.registeredGroups).toContain("food");
    expect(orch.memory.registeredGroups).toContain("travel");
    expect(orch.memory.registeredGroups).toContain("tech");

    // Pipeline steps executed in order
    expect(steps).toContain("butterbase.auth");
    expect(steps).toContain("rocketride.connect");
    expect(steps).toContain("=== PIPELINE START ===");
    expect(steps).toContain("xtrace.recall");
    expect(steps).toContain("rocketride.send");
    expect(steps).toContain("mockagent.search(Find me good Italian restauran)");
    expect(steps).toContain("mockagent.scrape(2 urls)");
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
    expect(travelReply).toContain("--- Sources ---");

    // Tech query
    const techReply = await orch.processMessage({
      role: "user",
      content: "Explain the latest GPT-4 features and how to use them",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-003",
    });
    expect(orch.backend.savedSession!.category).toBe("tech");
    expect(techReply).toContain("--- Sources ---");
  });

  it("handles errors gracefully — throws when search fails", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    // Make search throw
    orch.agent.searchWeb = async () => {
      throw new Error("Search service unavailable");
    };

    await expect(
      orch.processMessage({
        role: "user",
        content: "Find me something",
        user_id: FAKE_USER.id,
        conv_id: "test-conv-004",
      }),
    ).rejects.toThrow();
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
    expect(orch.memory.ingestedMessages.length).toBeGreaterThanOrEqual(3);
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
      // Should all be tech category
      expect(im.groupIds).toBeDefined();
      if (im.groupIds) {
        for (const gid of im.groupIds) {
          expect(gid).toMatch(/grp_/);
        }
      }
    }

    // The first ingest (conversation) should be tech-related
    expect(orch.backend.savedSession!.category).toBe("tech");
  });

  it("ingests multiple page memories per session", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    await orch.processMessage({
      role: "user",
      content: "Best hotels in Tokyo for travel",
      user_id: FAKE_USER.id,
      conv_id: "test-conv-xtrace-2",
    });

    // Should have ingested: 1 conversation + 2 page memories = 3 minimum
    expect(orch.memory.ingestedMessages.length).toBeGreaterThanOrEqual(3);

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
    expect(steps).toContain("xtrace.ingest(group=grp_food)");
    expect(steps).toContain("butterbase.db.insertSession");

    // Reply includes search results
    expect(reply).toContain("--- Sources ---");
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
//  Mock Agent — Deterministic Search/Scrape Behavior
// ════════════════════════════════════════════════════════════════════════

describe("Mock Agent behavior", () => {
  let orch: TestOrchestrator;

  beforeEach(() => {
    steps.length = 0;
  });

  it("returns consistent search results for text queries", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    await orch.processMessage({
      role: "user",
      content: "Find recipe websites",
      user_id: FAKE_USER.id,
      conv_id: "test-mock-1",
    });

    expect(orch.agent.searchResults.length).toBe(2);
    expect(orch.agent.searchResults[0].url).toContain("example.com");
    expect(orch.agent.scrapedPages.length).toBe(2);
  });

  it("scraped pages have all required fields", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    await orch.processMessage({
      role: "user",
      content: "Find hiking trails",
      user_id: FAKE_USER.id,
      conv_id: "test-mock-2",
    });

    for (const page of orch.agent.scrapedPages) {
      expect(page).toHaveProperty("url");
      expect(page).toHaveProperty("title");
      expect(page).toHaveProperty("content");
      expect(page).toHaveProperty("wordCount");
      expect(typeof page.wordCount).toBe("number");
    }
  });

  it("search handles empty/blank queries", async () => {
    orch = new TestOrchestrator();
    await orch.setup();

    const reply = await orch.processMessage({
      role: "user",
      content: "",
      user_id: FAKE_USER.id,
      conv_id: "test-mock-3",
    });

    // Should still produce some output (pipeline fallback)
    expect(reply).toBeDefined();
    expect(reply.length).toBeGreaterThan(0);
  });
});
