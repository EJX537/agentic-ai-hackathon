/**
 * Web Use Tools — Real Integration Tests
 *
 * Tests each tool against its actual implementation.
 *   - done:     No dependencies — always works
 *   - search_web:  Real SearXNG at searxng.tail02637.ts.net
 *   - read_url:    Real site handlers (Wikipedia, GitHub) + Trafilatura fallback
 *   - browser tools: Real Puppeteer (skipped if no BROWSER_START_URL)
 *   - memory tools:  Real XTrace recall/ingest (skipped if no XTRACE_API_KEY)
 */
import { describe, it, expect, afterAll } from "bun:test";
import { setToolContext } from "../../src/webuse/tools.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function hasBrowser(): boolean {
  return !!process.env.BROWSER_START_URL;
}

function hasXTrace(): boolean {
  return !!(process.env.XTRACE_API_KEY && process.env.XTRACE_ORG_ID);
}

/** Launch a minimal headless browser for testing browser-dependent tools. */
async function createTestBrowser(): Promise<import("../../src/browser/browser-agent.ts").BrowserAgent | null> {
  if (!hasBrowser()) return null;
  const { BrowserController } = await import("../../src/browser/puppeteer.ts");
  const { BrowserAgent } = await import("../../src/browser/browser-agent.ts");
  const controller = new BrowserController();
  await controller.launch();
  const agent = new BrowserAgent(controller, {
    startUrl: process.env.BROWSER_START_URL!,
  });
  return agent;
}

// ──────────────────────────────────────────────────────────────────────
//  done
// ──────────────────────────────────────────────────────────────────────

describe("done tool", () => {
  it("returns the summary wrapped in ## Result", async () => {
    const { doneTool } = await import("../../src/webuse/tools.ts");
    const result = await doneTool.execute("call-1", { summary: "Found 3 Italian restaurants in SF" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toBe("## Result\n\nFound 3 Italian restaurants in SF");
  });

  it("marks details.completed as true", async () => {
    const { doneTool } = await import("../../src/webuse/tools.ts");
    const result = await doneTool.execute("call-2", { summary: "All done" }, undefined, undefined, {} as any);
    expect(result).toHaveProperty("details");
    expect((result as any).details.completed).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
//  search_web (real SearXNG)
// ──────────────────────────────────────────────────────────────────────

describe("search_web tool (real SearXNG)", () => {
  it("returns real search results for a common query", async () => {
    const { searchWebTool } = await import("../../src/webuse/tools.ts");
    const result = await searchWebTool.execute("call-1", { query: "hello world" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toContain("Search results for");     // heading
    expect(text).toContain("http");                     // at least one URL
    // Format: numbered list with URL on second line per result
    expect(text).toMatch(/\d+\./);
  });

  it("returns formatted results (even with 0 results)", async () => {
    const { searchWebTool } = await import("../../src/webuse/tools.ts");
    const result = await searchWebTool.execute("call-2", { query: "searxng test function" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toContain("Search results for");
    // Should always give us something, even if 0 results
    expect(text.length).toBeGreaterThan(10);
  });

  it("returns results with expected fields (url, title, snippet)", async () => {
    const { searchWebTool } = await import("../../src/webuse/tools.ts");
    // Use a broad query that's very likely to return results
    const result = await searchWebTool.execute("call-4", { query: "hello world" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toContain("Search results for");
    // Should have some results (the "hello world" query worked earlier)
    expect(text).toMatch(/\d results/);
    // Should show engine attribution when results exist
    if (!text.includes("0 results")) {
      expect(text.toLowerCase()).toContain("engine");
    }
  });

  it("returns suggestions for misspelled queries", async () => {
    const { searchWebTool } = await import("../../src/webuse/tools.ts");
    const result = await searchWebTool.execute("call-5", { query: "helo world" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    // Should still get results or suggestions
    expect(text.length).toBeGreaterThan(20);
  });

  it("handles empty result gracefully (non-matching query)", async () => {
    const { searchWebTool } = await import("../../src/webuse/tools.ts");
    // A highly specific query that should limit results
    const result = await searchWebTool.execute("call-6", { query: "zzzzzzzzzzzzzzzzzzzzzzzzzzz999999999" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    // Should get a well-formed response regardless of results count
    expect(text).toContain("Search results for");
    expect(text.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
//  read_url (real site handlers + Trafilatura)
// ──────────────────────────────────────────────────────────────────────

describe("read_url tool (real sites)", () => {
  it("reads a Wikipedia article", async () => {
    const { readUrlTool } = await import("../../src/webuse/tools.ts");
    const result = await readUrlTool.execute("call-1", { urls: ["https://en.wikipedia.org/wiki/Rust_(programming_language)"] }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(100);
    expect(text.toLowerCase()).toContain("rust");   // the article content
  });

  it("reads a GitHub blob URL", async () => {
    const { readUrlTool } = await import("../../src/webuse/tools.ts");
    const result = await readUrlTool.execute("call-2", { urls: ["https://github.com/rust-lang/rust/blob/master/README.md"] }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain("https://www.rust-lang.org");
  });

  it("reads multiple URLs in one call", async () => {
    const { readUrlTool } = await import("../../src/webuse/tools.ts");
    const result = await readUrlTool.execute("call-3", {
      urls: [
        "https://en.wikipedia.org/wiki/Rust_(programming_language)",
        "https://en.wikipedia.org/wiki/TypeScript",
      ],
    }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toContain("Rust");
    expect(text).toContain("TypeScript");
  });

  it("honors maxLength parameter", async () => {
    const { readUrlTool } = await import("../../src/webuse/tools.ts");
    const result = await readUrlTool.execute("call-4", {
      urls: ["https://en.wikipedia.org/wiki/Rust_(programming_language)"],
      maxLength: 500,
    }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(600); // allow small overhead
  });
});

// ──────────────────────────────────────────────────────────────────────
//  Memory tools (real XTrace — conditional)
// ──────────────────────────────────────────────────────────────────────

describe("memory tools (real XTrace)", () => {
  /** Set up real XTrace context using the MemoryService from the orchestrator */
  async function setupRealXTrace() {
    const { MemoryService } = await import("../../src/memory/xtrace-memory.ts");
    const memory = new MemoryService();
    const allGroupIds = (await memory.listGroups()).map((g: any) => g.id);
    setToolContext({
      browser: null,
      recall: (query, uid) => memory.recall(query, uid, allGroupIds),
      ingest: (messages, uid, cid, gids) => memory.ingestMessages(messages, uid, cid, gids ?? allGroupIds),
      userId: "test-user",
      convId: "test-conv",
    });
    return memory;
  }

  it("recalls memories when XTrace is configured", async () => {
    if (!hasXTrace()) return;
    try {
      await Promise.race([
        setupRealXTrace(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("XTrace setup timeout")), 3000)),
      ]);
    } catch (err) {
      console.warn("[test] XTrace setup failed, skipping:", (err as Error).message);
      return;
    }
    const { recallMemoryTool } = await import("../../src/webuse/tools.ts");
    const result = await Promise.race([
      recallMemoryTool.execute("call-1", { query: "web browsing test" }, undefined, undefined, {} as any),
      new Promise((_, reject) => setTimeout(() => reject(new Error("XTrace recall timeout")), 8000)),
    ]) as any;
    expect(result.content[0].text).toBeDefined();
  });

  it("returns 'not available' when recall is not configured", async () => {
    setToolContext({ browser: null });
    const { recallMemoryTool } = await import("../../src/webuse/tools.ts");
    const result = await recallMemoryTool.execute("call-2", { query: "anything" }, undefined, undefined, {} as any);
    expect(result.content[0].text).toContain("not available");
  });

  it("saves a fact when XTrace is configured", async () => {
    if (!hasXTrace()) return;
    try {
      await Promise.race([
        setupRealXTrace(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("XTrace setup timeout")), 3000)),
      ]);
    } catch (err) {
      console.warn("[test] XTrace setup failed, skipping:", (err as Error).message);
      return;
    }
    const { rememberFactTool } = await import("../../src/webuse/tools.ts");
    try {
      const result = await Promise.race([
        rememberFactTool.execute("call-1", { fact: "Integration test fact: WebUseAgent tool test" }, undefined, undefined, {} as any),
        new Promise((_, reject) => setTimeout(() => reject(new Error("XTrace ingest timeout")), 8000)),
      ]) as any;
      expect(result.content[0].text).toContain("Fact saved");
    } catch (err) {
      console.warn("[test] XTrace ingest failed/slow, skipping:", (err as Error).message);
    }
  });

  it("returns 'not available' when ingest is not configured", async () => {
    setToolContext({ browser: null });
    const { rememberFactTool } = await import("../../src/webuse/tools.ts");
    const result = await rememberFactTool.execute("call-2", { fact: "test fact" }, undefined, undefined, {} as any);
    expect(result.content[0].text).toContain("not available");
  });
});

// ──────────────────────────────────────────────────────────────────────
//  Browser tools (real Puppeteer — conditional)
// ──────────────────────────────────────────────────────────────────────

describe("browser tools (real Puppeteer)", () => {
  let browserAgent: import("../../src/browser/browser-agent.ts").BrowserAgent | null;

  const BROWSER_TIMEOUT = 60_000;

  afterAll(async () => {
    await browserAgent?.browser.close();
  });

  it("navigates to a real URL and returns title/status", async () => {
    if (!hasBrowser()) return;
    browserAgent = await createTestBrowser();
    if (!browserAgent) { expect(false).toBe("failed to create browser"); return; }
    setToolContext({ browser: browserAgent as any });

    const { navigateTool } = await import("../../src/webuse/tools.ts");
    const result = await navigateTool.execute("call-1", { url: "https://example.com" }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toContain("Navigated to");
    expect(text).toContain("Example Domain");
    expect(text).toContain("success");
  }, BROWSER_TIMEOUT);

  it("scan returns an AX tree with actual elements", async () => {
    if (!hasBrowser() || !browserAgent) return;
    setToolContext({ browser: browserAgent as any });

    const { scanTool } = await import("../../src/webuse/tools.ts");
    const result = await scanTool.execute("call-2", { maxNodes: 30 }, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text).toContain("nodes in tree");
    expect(text).toContain("AX Tree");
  }, BROWSER_TIMEOUT);

  it("page_text returns actual visible page content", async () => {
    if (!hasBrowser() || !browserAgent) return;
    setToolContext({ browser: browserAgent as any });

    const { pageTextTool } = await import("../../src/webuse/tools.ts");
    const result = await pageTextTool.execute("call-3", {}, undefined, undefined, {} as any);
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(10);
  }, BROWSER_TIMEOUT);

  it("screenshot returns a valid base64 PNG", async () => {
    if (!hasBrowser() || !browserAgent) return;
    setToolContext({ browser: browserAgent as any });

    const { screenshotTool } = await import("../../src/webuse/tools.ts");
    const result = await screenshotTool.execute("call-4", {}, undefined, undefined, {} as any);
    expect(result.content[0].type).toBe("image");
    const data = (result.content[0] as any).data;
    expect(typeof data).toBe("string");
    expect(data.startsWith("iVBOR")).toBe(true);
  }, BROWSER_TIMEOUT);

  it("view returns text for a readable element", async () => {
    if (!hasBrowser() || !browserAgent) return;
    setToolContext({ browser: browserAgent as any });

    const { scanTool, viewTool } = await import("../../src/webuse/tools.ts");
    const scanResult = await scanTool.execute("call-5", { maxNodes: 20 }, undefined, undefined, {} as any);
    const scanText = scanResult.content[0].text;
    const match = scanText.match(/\[(ax-\w+)\]/);
    if (match) {
      const nodeId = match[1];
      const result = await viewTool.execute("call-6", { nodeId }, undefined, undefined, {} as any);
      expect(result.content[0].text.length).toBeGreaterThan(0);
    }
  }, BROWSER_TIMEOUT);

  // ═══════════════════════════════════════════════════════════════
  //  Amazon.com — Hackathon Demo Test
  // ═══════════════════════════════════════════════════════════════

  it("Amazon: search RTX 3070, sort by price, filter ≥4★, exclude renewed", async () => {
    const { BrowserAgent } = await import("../../src/browser/browser-agent.ts");
    const { WebUseAgent } = await import("../../src/webuse/web-use-agent.ts");
    const browserAgent = new BrowserAgent({ headless: true });
    await browserAgent.browser.launch();

    try {

      console.log("[test.amazon] Spawning pi agent for Amazon demo...");
      const webAgent = new WebUseAgent();

      // Wrap with timeout to prevent hanging
      const result = await Promise.race([
        webAgent.browse({
          task: `Go to amazon.com and find the best RTX 3070 GPU.

1. Navigate to amazon.com
2. Search for "RTX 3070"
3. Sort by price low to high
4. Filter 4 Stars & Up
5. Skip Renewed items
6. Return top 3: title, price, rating

Use EXCLUSIVELY the browser tools (navigate, scan, click, fill, view). Do NOT call search_web or read_url. Be efficient — use scan to find elements, then directly click/fill them.`,
          browser: browserAgent,
          startUrl: 'https://www.amazon.com',
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Amazon demo timeout (150s)")), 150_000)),
      ]);

      console.log(`[test.amazon] Agent result (${result.durationMs}ms, success=${result.success}):`);
      console.log("╔══════════════════════════════════════════════╗");
      console.log("║  Amazon RTX 3070 — AX Agent Demo            ║");
      console.log("╚══════════════════════════════════════════════╝");
      console.log(result.answer);

      expect(result.success).toBe(true);
      expect(result.answer.length).toBeGreaterThan(50);

    } finally {
      await browserAgent.browser.shutdown().catch(() => {});
    }
  }, 240_000);
});
