/**
 * Puppeteer — Browser automation for agent workflows
 *
 * Launches a headless (or headed) Chromium instance, navigates pages,
 * and exposes a DOM bridge that integrates with the AX annotation layer
 * for agent-driven interaction.
 *
 * Docs: https://pptr.dev
 * API:  puppeteer@25.1.0
 */
import puppeteer, { type Browser, type Page } from "puppeteer";

export interface BrowserOptions {
  /** Headless mode (default: true) */
  headless?: boolean;
  /** Browser viewport width (default: 1280) */
  width?: number;
  /** Browser viewport height (default: 800) */
  height?: number;
  /** Extra Chromium launch args */
  args?: string[];
}

export interface PageNavigation {
  url: string;
  title: string;
  status: "success" | "timeout" | "error";
  durationMs: number;
}

export class BrowserController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private options: Required<BrowserOptions>;

  constructor(options: BrowserOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      width: options.width ?? 1280,
      height: options.height ?? 800,
      args: options.args ?? [],
    };
  }

  /**
   * Launch Chromium and open a fresh page.
   */
  async launch(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: this.options.headless ? true : false,
      args: [
        `--window-size=${this.options.width},${this.options.height}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        ...this.options.args,
      ],
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: this.options.width,
      height: this.options.height,
    });

    console.log("[Puppeteer] Browser launched");
  }

  /**
   * Navigate to a URL and wait for the page to load.
   */
  async navigate(url: string, waitUntil: "load" | "networkidle2" = "networkidle2"): Promise<PageNavigation> {
    if (!this.page) throw new Error("Browser not launched. Call .launch() first.");

    const start = performance.now();
    try {
      const resp = await this.page.goto(url, { waitUntil, timeout: 30_000 });
      return {
        url: this.page.url(),
        title: await this.page.title(),
        status: resp?.ok() ? "success" : "error",
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        url,
        title: "",
        status: "timeout",
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /**
   * Evaluate a script in the page context.
   */
  async evaluate<T = unknown>(fn: (...args: unknown[]) => T, ...args: unknown[]): Promise<T> {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.evaluate(fn, ...args);
  }

  /**
   * Find an element by CSS selector.
   */
  async $(selector: string) {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.$(selector);
  }

  /**
   * Click an element identified by selector.
   */
  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not launched.");
    await this.page.click(selector);
  }

  /**
   * Type text into an input field.
   */
  async type(selector: string, text: string, delay = 10): Promise<void> {
    if (!this.page) throw new Error("Browser not launched.");
    await this.page.type(selector, text, { delay });
  }

  /**
   * Get the page's full HTML content.
   */
  async content(): Promise<string> {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.content();
  }

  /**
   * Get visible text on the page.
   */
  async text(): Promise<string> {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.evaluate(() => document.body.innerText);
  }

  /**
   * Take a screenshot (returns base64-encoded PNG).
   */
  async screenshot(): Promise<string> {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.screenshot({ encoding: "base64", type: "png" });
  }

  /**
   * Inject AX into the page and initialise autobindgen.
   *
   * This evaluates the ax-core and ax-autobindgen bundles in the
   * browser context so agent-driven DOM annotation works on the page.
   */
  async injectAx(axBundle: string, autobindgenBundle: string): Promise<void> {
    if (!this.page) throw new Error("Browser not launched.");

    // Strip ESM export lines — these bundles have `export { ... }` / `export default ...`
    // at the end for Node module consumers but break in a browser context.
    // Strip the multi-line export block at the end:
    //   export {
    //     src_default as default
    //   };
    // Note: the file has a trailing newline before EOF.
    const cleanAx = axBundle.replace(/export\s*\{[\s\S]*?\};\n*$/, "");
    // Strip a single-line export default line:
    const cleanAbg = autobindgenBundle.replace(/^export\s+default\s+.+;?$/m, "");

    // Use page.evaluate with the raw code (CDP Runtime.evaluate bypasses CSP).
    // The bundles use `var name = ...` — inside the CDP async wrapper these are local,
    // so we explicitly assign to window.
    await this.page.evaluate(cleanAx + "\nwindow.ax = ax;");
    await this.page.evaluate(cleanAbg + "\nwindow.axAutobindgen = axAutobindgen;");

    // Configure and bind
    await this.page.evaluate(() => {
      // @ts-expect-error — injected by evaluate
      window.axAutobindgen.configure({ builtins: true });
      // @ts-expect-error
      window.axAutobindgen.bind();
    });

    console.log("[Puppeteer] AX injected and bound");
  }

  /**
   * Run a full AX scan in the browser and return the result.
   */
  async scanAx(): Promise<unknown> {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.evaluate(() => {
      // @ts-expect-error — injected by evaluate
      return window.ax.scan();
    });
  }

  /**
   * Invoke an AX action on an element in the browser.
   */
  async invokeAx(selector: string, action: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.page) throw new Error("Browser not launched.");
    return this.page.evaluate(
      (sel, act, a) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        // @ts-expect-error — injected by evaluate
        return window.ax.invoke(el, act, a);
      },
      selector,
      action,
      args,
    );
  }

  /**
   * Get the underlying Page for direct Puppeteer access.
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * Close the browser and clean up.
   */
  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      console.log("[Puppeteer] Browser closed");
    }
  }
}
