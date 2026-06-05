/**
 * BrowserAgent — high-level agent that drives a browser via Puppeteer + AX.
 *
 * Combines browser automation (Puppeteer) with DOM annotation (AX) so the
 * agent orchestrator can navigate, scan, and interact with web pages as
 * part of its pipeline.
 */
import { BrowserController, type BrowserOptions } from "./puppeteer.ts";
import type { DomAction } from "../dom/ax-interface.ts";

export { BrowserController } from "./puppeteer.ts";
export type { BrowserOptions, PageNavigation } from "./puppeteer.ts";

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
   * Shut down the browser.
   */
  async shutdown(): Promise<void> {
    await this.browser.shutdown();
  }
}
