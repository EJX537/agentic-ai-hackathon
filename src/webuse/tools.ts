/**
 * Web Use Tools — Custom tool definitions for the embedded web-use pi agent.
 *
 * These tools let an LLM agent navigate web pages via AX: scan the DOM tree,
 * click elements, fill forms, extract text, and take screenshots.
 */
import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrowserAgent, AxNodeWithSelector, AxScanResult } from "../browser/browser-agent.ts";
import type { Message } from "../types/index.ts";
import { searchWeb, formatSearchResults } from "./searxng.ts";
import { readUrls } from "./read-url.ts";

// ── Shared state ──────────────────────────────────────────────────────
export interface ToolContext {
  browser: BrowserAgent | null;
  /** XTrace memory service for recalling facts during browsing */
  recall?: (query: string, userId: string, groupIds?: string[]) => Promise<{ prompt: string }>;
  /** XTrace memory service for ingesting facts after browsing */
  ingest?: (messages: Message[], userId: string, convId: string, groupIds?: string[]) => Promise<number>;
  /** Current user ID (passed from orchestrator) */
  userId?: string;
  /** Current conversation ID */
  convId?: string;
}

let _ctx: ToolContext = { browser: null };

export function setToolContext(ctx: ToolContext): void {
  _ctx = ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatTree(tree: AxScanResult, maxNodes = 80): string {
  const lines: string[] = [];
  const dag = tree.dag;

  const nodeMap = new Map<string, AxNodeWithSelector>();
  for (const n of tree.nodes) nodeMap.set(n.id, n);

  const roots = tree.nodes.filter(
    (n) => n.parent === null || n.parent === "null" || !nodeMap.has(n.parent!),
  );

  function walk(nodeId: string, depth: number) {
    if (lines.length >= maxNodes) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const indent = "  ".repeat(depth);
    const fns = node.fn
      .filter((f) => f.on !== "ignore")
      .map((f) => {
        if (f.on === "edit" && f.args) {
          const args = Object.entries(f.args)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ");
          return `${f.on}:${f.name}[${args}]`;
        }
        return `${f.on}:${f.name}`;
      })
      .join(" ");

    lines.push(fns ? `${indent}[${node.id}] <${node.tagName}> ${fns}` : `${indent}[${node.id}] <${node.tagName}>`);

    const children = dag[node.id] || [];
    for (const childId of children) walk(childId, depth + 1);
  }

  for (const root of roots) walk(root.id, 0);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────
//  Tool: search_web
// ──────────────────────────────────────────────────────────────────────

export const searchWebTool = defineTool({
  name: "search_web",
  label: "Web Search",
  description:
    "Search the web using SearXNG metasearch engine. " +
    "Returns titles, URLs, snippets, engine sources, and dates. " +
    "Use this FIRST when asked to find information. After finding relevant URLs, " +
    "use read_url() to read the full content of promising pages.",
  parameters: Type.Object({
    query: Type.String({
      description: "The search query",
      minLength: 1,
    }),
    pageno: Type.Optional(
      Type.Number({
        description: "Search page number (starts at 1)",
        default: 1,
      }),
    ),
    time_range: Type.Optional(
      Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year")], {
        description: "Time range filter (day, month, year)",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "Language code (e.g. 'en', 'fr', 'de')",
        default: "all",
      }),
    ),
    safesearch: Type.Optional(
      Type.Number({
        description: "Safe search level (0=None, 1=Moderate, 2=Strict)",
        default: 0,
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const data = await searchWeb({
        query: params.query,
        pageno: params.pageno ?? 1,
        time_range: params.time_range,
        language: params.language,
        safesearch: params.safesearch,
      });
      return {
        content: [{ type: "text" as const, text: formatSearchResults(data) }],
        details: {
          query: params.query,
          resultCount: (data.results ?? []).length,
        },
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Search error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: read_url
// ──────────────────────────────────────────────────────────────────────

export const readUrlTool = defineTool({
  name: "read_url",
  label: "Read URL",
  description:
    "Fetch and extract the main content from a web page. " +
    "Uses site-specific handlers for Wikipedia, GitHub, YouTube, Stack Overflow, and MDN " +
    "with Trafilatura as the generic fallback. Returns clean Markdown. " +
    "Use this AFTER search_web() to read full content of promising URLs.",
  parameters: Type.Object({
    urls: Type.Array(Type.String(), {
      description: "One or more URLs to read. Always pass as an array.",
      minItems: 1,
    }),
    startChar: Type.Optional(
      Type.Number({
        description: "Starting character position (default: 0)",
        default: 0,
      }),
    ),
    maxLength: Type.Optional(
      Type.Number({
        description: "Maximum characters to return per URL (default: 8000)",
        default: 8000,
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const result = await readUrls({
        urls: params.urls,
        startChar: params.startChar ?? 0,
        maxLength: params.maxLength ?? 8000,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { count: result.count, statuses: result.results.map((r) => ({ url: r.url, handler: r.handler, truncated: r.truncated, error: r.error })) },
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Read URL error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: navigate
// ──────────────────────────────────────────────────────────────────────

export const navigateTool = defineTool({
  name: "navigate",
  label: "Navigate to URL",
  description:
    "Navigate the browser to a URL. Returns the page title and status. " +
    "Use this FIRST to go to a page. After navigation, call scan() to see what's on the page.",
  parameters: Type.Object({
    url: Type.String({ description: "The full URL to navigate to", minLength: 1 }),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      const nav = await _ctx.browser.browser.navigate(params.url);
      return {
        content: [{ type: "text" as const, text: `Navigated to ${nav.url}\nTitle: ${nav.title}\nStatus: ${nav.status} (${nav.durationMs}ms)` }],
        details: { success: true, url: nav.url, title: nav.title, status: nav.status },
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Navigation error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: scan
// ──────────────────────────────────────────────────────────────────────

export const scanTool = defineTool({
  name: "scan",
  label: "Scan Page",
  description:
    "Scan the current page with AX to get the interactive element tree. " +
    "Returns a tree of clickable elements, form fields, links, and text regions. " +
    "Each node has an ID you can use with click(), fill(), or view(). " +
    "Call this after navigate() and after any action to see the updated page state.",
  parameters: Type.Object({
    maxNodes: Type.Optional(Type.Number({ description: "Maximum nodes to show (default: 60)", default: 60 })),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      const tree = await _ctx.browser.scanWithSelectors();
      const formatted = formatTree(tree, params.maxNodes ?? 60);
      return {
        content: [{ type: "text" as const, text: `${tree.nodes.length} nodes in tree\n\n--- AX Tree ---\n${formatted}` }],
        details: { success: true, nodeCount: tree.nodes.length },
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Scan error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: click
// ──────────────────────────────────────────────────────────────────────

export const clickTool = defineTool({
  name: "click",
  label: "Click Element",
  description:
    "Click an element identified by its AX node ID (e.g. 'ax-1a2b3c'). " +
    "Press buttons, follow links, toggle switches, select options. " +
    "After clicking, call scan() again to see the updated page state.",
  parameters: Type.Object({
    nodeId: Type.String({ description: "The AX node ID from the scan tree", minLength: 1 }),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      await _ctx.browser.invokeByNodeId(params.nodeId, "click");
      return { content: [{ type: "text" as const, text: `Clicked node ${params.nodeId}. Call scan() to see changes.` }], details: { success: true, nodeId: params.nodeId } };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Click error on ${params.nodeId}: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: fill
// ──────────────────────────────────────────────────────────────────────

export const fillTool = defineTool({
  name: "fill",
  label: "Fill Form Field",
  description:
    "Fill a text input, textarea, or other editable field by its AX node ID. " +
    "Use this to type into search boxes, forms, and input fields.",
  parameters: Type.Object({
    nodeId: Type.String({ description: "The AX node ID from the scan tree", minLength: 1 }),
    value: Type.String({ description: "The text to type into the field", minLength: 1 }),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      await _ctx.browser.invokeByNodeId(params.nodeId, "edit", { value: params.value });
      return { content: [{ type: "text" as const, text: `Filled node ${params.nodeId}. Call scan() to see changes.` }], details: { success: true, nodeId: params.nodeId } };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Fill error on ${params.nodeId}: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: view
// ──────────────────────────────────────────────────────────────────────

export const viewTool = defineTool({
  name: "view",
  label: "View Element Text",
  description:
    "Extract visible text from an element by its AX node ID. " +
    "Use this to read the content of a specific section, paragraph, or container. " +
    "Returns up to 3000 characters.",
  parameters: Type.Object({
    nodeId: Type.String({ description: "The AX node ID from the scan tree", minLength: 1 }),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      const result = await _ctx.browser.invokeByNodeId(params.nodeId, "view");
      const text = String(result ?? "").slice(0, 3000);
      return { content: [{ type: "text" as const, text: text || "(no text)" }], details: { success: true, nodeId: params.nodeId, textLength: text.length } };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `View error on ${params.nodeId}: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: page_text
// ──────────────────────────────────────────────────────────────────────

export const pageTextTool = defineTool({
  name: "page_text",
  label: "Page Text",
  description:
    "Get all visible text on the current page (up to 10000 chars). " +
    "Use this for broad context rather than a specific section.",
  parameters: Type.Object({}),
  execute: async () => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      const text = await _ctx.browser.pageText();
      const truncated = text.length > 10000;
      const display = truncated ? text.slice(0, 10000) + "\n... (truncated)" : text;
      return { content: [{ type: "text" as const, text: display }], details: { success: true, totalLength: text.length, truncated } };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Page text error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: screenshot
// ──────────────────────────────────────────────────────────────────────

export const screenshotTool = defineTool({
  name: "screenshot",
  label: "Screenshot",
  description:
    "Take a screenshot of the current page. Returns a base64 PNG image " +
    "that vision-capable models can analyze for visual layout and design.",
  parameters: Type.Object({}),
  execute: async () => {
    if (!_ctx.browser) return { content: [{ type: "text" as const, text: "Browser not available." }], details: { error: "no browser" } } as any;
    try {
      const data = await _ctx.browser.screenshot();
      return { content: [{ type: "image" as const, data, mimeType: "image/png" as const }], details: { success: true, size: data.length } };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Screenshot error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: recall_memory
// ──────────────────────────────────────────────────────────────────────

export const recallMemoryTool = defineTool({
  name: "recall_memory",
  label: "Recall Memory",
  description:
    "Recall stored memories from XTrace related to a query. " +
    "Returns relevant facts the agent learned from previous browsing sessions. " +
    "Use this when you need context from past conversations or prior research.",
  parameters: Type.Object({
    query: Type.String({
      description: "What to search for in memory (semantic search)",
      minLength: 1,
    }),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.recall) {
      return { content: [{ type: "text" as const, text: "Memory not available (XTrace not configured)." }], details: { error: "no memory" } } as any;
    }
    try {
      const userId = _ctx.userId ?? "anonymous";
      const result = await _ctx.recall(params.query, userId);
      if (!result.prompt || result.prompt.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant memories found." }], details: { found: false } } as any;
      }
      return {
        content: [{ type: "text" as const, text: `## Related Memories

${result.prompt}` }],
        details: { found: true, chars: result.prompt.length },
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Memory recall error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: remember_fact
// ──────────────────────────────────────────────────────────────────────

export const rememberFactTool = defineTool({
  name: "remember_fact",
  label: "Remember Fact",
  description:
    "Save a fact or finding to XTrace long-term memory. " +
    "Use this at the end of a browsing session to persist important " +
    "information so future sessions can recall it. " +
    "Example: remember_fact(fact=\"Tony's Italian Restaurant in SF has a 4.5 star rating\")",
  parameters: Type.Object({
    fact: Type.String({
      description: "The fact or finding to remember",
      minLength: 1,
    }),
  }),
  execute: async (_toolCallId, params) => {
    if (!_ctx.ingest) {
      return { content: [{ type: "text" as const, text: "Memory not available (XTrace not configured)." }], details: { error: "no memory" } } as any;
    }
    try {
      const userId = _ctx.userId ?? "anonymous";
      const convId = _ctx.convId ?? crypto.randomUUID();
      const count = await _ctx.ingest(
        [
          { role: "system", content: "Fact from web browsing session" },
          { role: "assistant", content: params.fact },
        ],
        userId,
        convId,
      );
      return {
        content: [{ type: "text" as const, text: `Fact saved to memory (${count} memories created).` }],
        details: { saved: true, count },
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Memory save error: ${err}` }], details: { error: String(err) } } as any;
    }
  },
});

// ──────────────────────────────────────────────────────────────────────
//  Tool: done
// ──────────────────────────────────────────────────────────────────────

export const doneTool = defineTool({
  name: "done",
  label: "Done",
  description:
    "Call this when you have completed the user's task on the web page. " +
    "Provide a summary of what you found. Ends the browsing session.",
  parameters: Type.Object({
    summary: Type.String({ description: "Summary of what you found and did", minLength: 1 }),
  }),
  execute: async (_toolCallId, params) => {
    return { content: [{ type: "text" as const, text: `## Result\n\n${params.summary}` }], details: { success: true, completed: true } };
  },
});

// ──────────────────────────────────────────────────────────────────────
//  All tools
// ──────────────────────────────────────────────────────────────────────

export const webUseTools = [
  // Phase 0: Memory context
  recallMemoryTool,
  rememberFactTool,
  // Phase 1: Search & Read (static content)
  searchWebTool,
  readUrlTool,
  // Phase 2: Browse (JS-rendered / interactive pages)
  navigateTool,
  scanTool,
  clickTool,
  fillTool,
  viewTool,
  pageTextTool,
  screenshotTool,
  doneTool,
];
