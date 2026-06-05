/**
 * Scrape Tool — Mock implementation.
 *
 * Actual Phase 2 will use:
 *   - Trafilatura (Python) for clean text extraction from indexed pages
 *   - Puppeteer + AX for live JS-heavy pages
 *
 * For now returns canned content so the pipeline compiles and runs.
 */

export interface ScrapedContent {
  url: string;
  title: string;
  content: string;
  /** Approximate word count of extracted content. */
  wordCount: number;
}

/**
 * Extract clean content from a URL.
 *
 * @returns The page title and extracted text content.
 */
export async function scrapePage(url: string): Promise<ScrapedContent | null> {
  console.log(`[Scrape:MOCK] Extracting content from "${url}"`);

  // ── Mock extraction ───────────────────────────────────────────────
  return {
    url,
    title: `Mock page for ${url}`,
    content:
      `This is mock extracted content from ${url}. ` +
      `In the real implementation, Trafilatura would extract clean text ` +
      `by removing navigation, ads, sidebars, and boilerplate. ` +
      `For JavaScript-heavy pages, Puppeteer would render the page first, ` +
      `then AX would scan for interactive elements, and the agent could ` +
      `perform actions like clicking buttons, filling forms, or scrolling. `.repeat(5),
    wordCount: 150,
  };
}

/**
 * Extract content from multiple URLs in parallel.
 */
export async function scrapePages(urls: string[]): Promise<ScrapedContent[]> {
  const results = await Promise.allSettled(urls.map(scrapePage));
  return results
    .filter(
      (r): r is PromiseFulfilledResult<ScrapedContent> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);
}
