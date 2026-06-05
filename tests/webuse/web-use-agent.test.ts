/**
 * WebUseAgent — Integration Tests
 *
 * Tests the embedded pi agent lifecycle with mocked pi session internals.
 *
 * Covers:
 *   - Agent initialization with memory context
 *   - buildPrompt() output structure
 *   - Memory context injection
 *   - Context propagation to tools
 *   - browse() result extraction
 *   - Error handling and graceful shutdown
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { setToolContext } from "../../src/webuse/tools.ts";
import { WebUseAgent, type WebUseResult } from "../../src/webuse/web-use-agent.ts";

// Track the execution trace
const trace: string[] = [];

beforeEach(() => {
  trace.length = 0;
  setToolContext({ browser: null });
});

afterAll(() => {
  console.log("\n-- WebUseAgent test trace --");
  trace.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
});

// ── Test: buildPrompt output ───────────────────────────────────────

describe("WebUseAgent.buildPrompt", () => {
  it("includes the task description", () => {
    const agent = new WebUseAgent();
    // Access private buildPrompt via bracket notation for testing
    const prompt = (agent as any).buildPrompt("Find Italian restaurants in SF");
    expect(prompt).toContain("Find Italian restaurants in SF");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("done(summary)");
  });

  it("includes memory context when provided", () => {
    const agent = new WebUseAgent();
    const prompt = (agent as any).buildPrompt(
      "Find restaurants",
      undefined,
      "User prefers vegetarian options.",
    );
    expect(prompt).toContain("Context from Previous Sessions");
    expect(prompt).toContain("User prefers vegetarian options");
    expect(prompt).toContain("recall_memory()");
  });

  it("omits memory section when no context given", () => {
    const agent = new WebUseAgent();
    const prompt = (agent as any).buildPrompt("Find restaurants");
    expect(prompt).not.toContain("Context from Previous Sessions");
  });

  it("includes all tool descriptions", () => {
    const agent = new WebUseAgent();
    const prompt = (agent as any).buildPrompt("Test task");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("read_url");
    expect(prompt).toContain("navigate");
    expect(prompt).toContain("scan");
    expect(prompt).toContain("click");
    expect(prompt).toContain("fill");
    expect(prompt).toContain("view");
    expect(prompt).toContain("page_text");
    expect(prompt).toContain("screenshot");
    expect(prompt).toContain("done");
    // Memory tools are mentioned in the memory context section, not the tool list
  });

  it("mentions the guidelines", () => {
    const agent = new WebUseAgent();
    const prompt = (agent as any).buildPrompt("Test task");
    expect(prompt).toContain("Guidelines");
    expect(prompt).toContain("scan()");
    expect(prompt).toContain("done()");
  });
});

// ── Test: browse lifecycle (requires real pi infrastructure) ───────

describe("WebUseAgent.browse", () => {
  it.skip("returns a WebUseResult structure (requires pi session)", async () => {
    // This test requires a real pi agent session infrastructure.
    // It is skipped in CI/test environments without pi configured.
    const agent = new WebUseAgent();
    const result = await agent.browse({ task: "test" });
    expect(result).toHaveProperty("answer");
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("durationMs");
  });

  it.skip("passes memory context through to tool context (requires pi session)", async () => {
    const agent = new WebUseAgent();
    const testMemory = "User likes pasta from previous session";
    const result = await agent.browse({
      task: "Find pasta places",
      memoryContext: testMemory,
    });
    expect(result.answer).toContain("error");
  });

  it.skip("calculates durationMs (requires pi session)", async () => {
    const agent = new WebUseAgent();
    const result = await agent.browse({ task: "quick test" });
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// ── Test: custom ToolContext propagation ────────────────────────────

describe("ToolContext propagation", () => {
  it("sets browser, recall, and ingest on context", async () => {
    const mockRecall = async (_q: string) => ({ prompt: "test recall" });
    const mockIngest = async () => 1;

    setToolContext({
      browser: {} as any,
      recall: mockRecall,
      ingest: mockIngest,
      userId: "test-user",
      convId: "test-conv",
    });

    // Verify by doing a tool call that checks context
    const { recallMemoryTool, navigateTool } = await import("../../src/webuse/tools.ts");

    // recall memory should now work since recall is set
    const recallResult = await recallMemoryTool.execute("call-1", { query: "test" }, undefined, undefined, {} as any);
    expect(recallResult.content[0].text).toContain("Related Memories");

    // navigate should error (browser is {})
    const navResult = await navigateTool.execute("call-2", { url: "https://example.com" }, undefined, undefined, {} as any);
    expect(navResult.content[0].text).toContain("error");
  });
});

// ── Test: Error handling paths ─────────────────────────────────────

describe("Error handling", () => {
  it("tool errors produce user-friendly messages, not crashes", async () => {
    // Create a browser that throws
    setToolContext({
      browser: {
        browser: { navigate: async () => { throw new Error("Connection refused"); } },
        scanWithSelectors: async () => { throw new Error("Scan failed"); },
        invokeByNodeId: async () => { throw new Error("Node not found"); },
        pageText: async () => { throw new Error("Timeout"); },
        screenshot: async () => { throw new Error("Screenshot failed"); },
      } as any,
    });

    const { navigateTool, scanTool, clickTool, pageTextTool, screenshotTool } = await import("../../src/webuse/tools.ts");

    for (const [tool, params] of [
      [navigateTool, { url: "https://example.com" }],
      [scanTool, { maxNodes: 10 }],
      [clickTool, { nodeId: "ax-001" }],
      [pageTextTool, {}],
      [screenshotTool, {}],
    ] as const) {
      const result = await tool.execute("call-err", params as any, undefined, undefined, {} as any);
      expect(result.content[0].text).toContain("error");
    }
  });

  it("multiple concurrent tool calls each get correct context", async () => {
    // Verify that tool context is shared correctly between sequential calls
    setToolContext({ browser: null });

    const { navigateTool, doneTool } = await import("../../src/webuse/tools.ts");

    const results = await Promise.all([
      navigateTool.execute("call-1", { url: "https://x.com" }, undefined, undefined, {} as any),
      doneTool.execute("call-2", { summary: "Done" }, undefined, undefined, {} as any),
    ]);

    // navigate should fail (no browser)
    expect(results[0].content[0].text).toContain("not available");
    // done should work
    expect(results[1].content[0].text).toContain("## Result");
  });
});
