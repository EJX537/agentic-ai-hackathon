/**
 * BrowserAgent — high-level agent that drives a browser via Puppeteer + AX.
 *
 * Combines browser automation (Puppeteer) with DOM annotation (AX) so the
 * agent orchestrator can navigate, scan, and interact with web pages as
 * part of its pipeline.
 *
 * Web Use Agent flow:
 *   1. navigate(url) → go to page
 *   2. scanWithSelectors() → get AX tree with CSS selectors
 *   3. LLM picks an action (click, fill, view, etc.)
 *   4. invokeByNodeId(nodeId, action, args) → perform action
 *   5. Re-scan → repeat
 */
import { BrowserController, type BrowserOptions } from "./puppeteer.ts";
import type { DomAction } from "../dom/ax-interface.ts";

export { BrowserController } from "./puppeteer.ts";
export type { BrowserOptions, PageNavigation } from "./puppeteer.ts";

/** An AX scan node enriched with a CSS selector for invocation. */
export interface AxNodeWithSelector {
  id: string;
  tagName: string;
  parent: string | null;
  children: string[];
  fn: Array<{ on: string; name: string; args?: Record<string, string> }>;
  selector: string;
  /** Human-readable description of what this node is */
  label: string;
}

/** Full scan result with enriched nodes. */
export interface AxScanResult {
  version: number;
  generatedAt: number;
  dag: Record<string, string[]>;
  nodes: AxNodeWithSelector[];
}

export class BrowserAgent {
  readonly browser: BrowserController;

  constructor(options: BrowserOptions = {}) {
    this.browser = new BrowserController(options);
  }

  /**
   * Launch the browser and navigate to the starting URL.
   */
  async start(startUrl?: string): Promise<void> {
    await this.browser.launch();

    if (startUrl) {
      const nav = await this.browser.navigate(startUrl);
      console.log(`[BrowserAgent] Navigated to ${nav.url} (${nav.status})`);
    }
  }

  /**
   * Scan the current page and return all AX-annotated actions.
   */
  async scanActions(): Promise<DomAction[]> {
    const scan = await this.browser.scanAx();
    if (!scan || typeof scan !== "object") return [];

    const nodes = (scan as { nodes?: Array<{ id: string; fn: Array<{ on: string; name: string }> }> }).nodes ?? [];
    const actions: DomAction[] = [];

    for (const node of nodes) {
      for (const fn of node.fn) {
        actions.push({ nodeId: node.id, kind: fn.on, label: fn.name });
      }
    }

    return actions;
  }

  /**
   * Scan the page with AX and enrich each node with a CSS selector.
   * Stores the node→selector mapping in the browser for later invocation.
   */
  async scanWithSelectors(): Promise<AxScanResult> {
    const raw = await this.browser.scanAx();
    if (!raw || typeof raw !== "object") {
      return { version: 0, generatedAt: Date.now(), dag: {}, nodes: [] };
    }

    const scan = raw as {
      version: number;
      generatedAt: number;
      dag: Record<string, string[]>;
      nodes: Array<{
        id: string;
        tagName?: string;
        parent: string | null;
        children: string[];
        fn: Array<{ on: string; name: string; args?: Record<string, string> }>;
      }>;
    };

    // Ask the browser to build selectors for each node ID
    const selectors = await this._buildSelectors(scan.nodes.map((n) => n.id));

    const enriched: AxNodeWithSelector[] = [];

    for (const node of scan.nodes) {
      const sel = selectors[node.id] || "";
      const primaryFn = node.fn[0];
      const label = primaryFn
        ? `${primaryFn.on}: ${primaryFn.name}`
        : `${node.tagName || "?"}`;

      enriched.push({
        id: node.id,
        tagName: node.tagName || "?",
        parent: node.parent,
        children: node.children,
        fn: node.fn,
        selector: sel,
        label,
      });
    }

    return {
      version: scan.version,
      generatedAt: scan.generatedAt,
      dag: scan.dag,
      nodes: enriched,
    };
  }

  /**
   * Invoke an AX action on an element identified by its AX node ID.
   */
  async invokeByNodeId(nodeId: string, action: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.browser.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (id: unknown, act: unknown, a: unknown) => {
        const nid = id as string;
        const nac = act as string;
        const nar = a as Record<string, unknown> | undefined;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = window as any;
        const ax = win.ax;

        // Find the element using stored selector
        const map = win.__axSelectors as Record<string, string> | undefined;
        if (!map?.[nid]) {
          // Fallback: fresh scan with ax
          ax.scan();
          const all = document.querySelectorAll("[ax-bindgen]");
          for (const el of all) {
            const singleScan = ax.scan(el);
            if (singleScan.nodes.length > 0 && singleScan.nodes[0].id === nid) {
              return ax.invoke(el, nac, nar);
            }
          }
          throw new Error(`Node ${nid} not found`);
        }
        const selector = map[nid];
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Element not found for selector: ${selector}`);

        return ax.invoke(el, nac, nar);
      },
      nodeId,
      action,
      args,
    );
  }

  /**
   * Invoke an AX action on the page by CSS selector.
   */
  async act(selector: string, action: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.browser.invokeAx(selector, action, args);
  }

  /**
   * Get page text content (useful for LLM context).
   */
  async pageText(): Promise<string> {
    return this.browser.text();
  }

  /**
   * Get a screenshot as base64 (useful for vision models).
   */
  async screenshot(): Promise<string> {
    return this.browser.screenshot();
  }

  /**
   * Build a CSS selector for each node ID by running in the browser.
   * Stores the mapping in window.__axSelectors for later use.
   */
  private async _buildSelectors(nodeIds: string[]): Promise<Record<string, string>> {
    if (nodeIds.length === 0) return {};

    return this.browser.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (ids: unknown) => {
        const nids = ids as string[];
        const map: Record<string, string> = {};

        function buildSelector(el: Element): string {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const tag = el.tagName.toLowerCase();
          const parent = el.parentElement;
          if (!parent) return tag;
          const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
          if (siblings.length === 1) return `${buildSelector(parent)} > ${tag}`;
          const idx = siblings.indexOf(el) + 1;
          return `${buildSelector(parent)} > ${tag}:nth-child(${idx})`;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = window as any;
        const ax = win.ax;

        // Walk all ax-annotated elements
        const all = document.querySelectorAll("[ax-bindgen], [ax-view], [ax-click], [ax-edit], [ax-nav], [ax-ctx]");
        for (const el of all) {
          const singleScan = ax.scan(el);
          if (singleScan.nodes.length > 0) {
            const id = singleScan.nodes[0].id;
            if (nids.includes(id)) {
              map[id] = buildSelector(el);
            }
          }
        }

        // Store for later use by invokeByNodeId
        (window as unknown as Record<string, unknown>).__axSelectors = map;

        return map;
      },
      nodeIds,
    );
  }

  /**
   * Shut down the browser.
   */
  async shutdown(): Promise<void> {
    await this.browser.shutdown();
  }
}
