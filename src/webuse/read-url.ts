/**
 * Page content reader.
 *
 * Extracts clean text/Markdown content from URLs using site-specific
 * handlers (Wikipedia API, GitHub raw, YouTube oEmbed, etc.) with
 * Trafilatura as the generic fallback.
 */

import { extractContent, type ExtractResult } from "./sites/index.ts";

export interface ReadUrlOptions {
  urls: string[];
  startChar?: number;
  maxLength?: number;
}

export interface ReadUrlResult {
  text: string;
  results: Array<ExtractResult & { url: string }>;
  count: number;
}

/**
 * Read content from one or more URLs.
 *
 * Returns clean Markdown with metadata. Each URL is handled by the best
 * available site-specific handler, falling back to Trafilatura.
 */
export async function readUrls(opts: ReadUrlOptions): Promise<ReadUrlResult> {
  const maxLen = opts.maxLength ?? 8000;
  const start = opts.startChar ?? 0;

  const raw = await Promise.all(
    opts.urls.map((url) => extractContent(url, start, maxLen)),
  );

  const results: Array<ExtractResult & { url: string }> = raw.map((r, i) => ({ ...r, url: opts.urls[i] ?? "unknown" }));

  // Build text content
  const parts: string[] = [];
  for (const r of results) {
    if (r.error) {
      parts.push(`=== ${r.url} ===\nError: ${r.error}\n`);
    } else {
      const label = r.truncated
        ? `=== ${r.url} (via ${r.handler}) — showing ${r.returnedChars} of ${r.totalChars} chars ===`
        : `=== ${r.url} (via ${r.handler}) — ${r.totalChars} chars ===`;
      parts.push(`${label}\n${r.text}\n`);
    }
  }

  return {
    text: parts.join("\n"),
    results,
    count: results.length,
  };
}
