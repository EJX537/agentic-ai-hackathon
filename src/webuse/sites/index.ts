/**
 * Site handler registry for web page content extraction.
 *
 * Dispatches URL extraction to the appropriate site-specific handler
 * (Wikipedia, GitHub, YouTube, Stack Overflow, MDN, Reddit),
 * falling back to trafilatura-based generic extraction.
 */

import { extractViaTrafilatura } from "./trafilatura.js";
import { handleWikipedia } from "./wikipedia.js";
import { handleGitHub } from "./github.js";
import { handleYouTube } from "./youtube.js";
import { handleStackOverflow } from "./stackoverflow.js";
import { handleMDN } from "./mdn.js";
import { handleReddit } from "./reddit.js";

export type SiteHandler = (url: string) => Promise<string | null>;

interface SiteHandlerEntry {
  name: string;
  handler: SiteHandler;
}

export interface ExtractResult {
  text: string;
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
  error?: string;
  handler: string;
}

// ── Registry (most specific first, generic fallback last) ──────────

const siteHandlers: SiteHandlerEntry[] = [
  { name: "wikipedia", handler: handleWikipedia },
  { name: "github", handler: handleGitHub },
  { name: "youtube", handler: handleYouTube },
  { name: "stackoverflow", handler: handleStackOverflow },
  { name: "mdn", handler: handleMDN },
  { name: "reddit", handler: handleReddit },
];

// ── Extraction ─────────────────────────────────────────────────────

/**
 * Extract content from a URL using the best available handler.
 */
export async function extractContent(
  url: string,
  startChar: number,
  maxLength: number,
): Promise<ExtractResult> {
  // 1. Try site-specific handlers
  for (const entry of siteHandlers) {
    try {
      const result = await entry.handler(url);
      if (result !== null) {
        const sliced = result.slice(startChar, startChar + maxLength);
        return {
          text: sliced,
          totalChars: result.length,
          returnedChars: sliced.length,
          truncated: result.length > startChar + maxLength,
          handler: entry.name,
        };
      }
    } catch {
      // Handler errored, try next
    }
  }

  // 2. Verify URL scheme
  if (!/^https?:\/\//i.test(url)) {
    return {
      text: "",
      totalChars: 0,
      returnedChars: 0,
      truncated: false,
      error: "URL must start with http:// or https://",
      handler: "none",
    };
  }

  // 3. Fallback to trafilatura
  const result = await extractViaTrafilatura(url, startChar, maxLength);
  return {
    text: result.text,
    totalChars: result.totalChars,
    returnedChars: result.text.length,
    truncated: result.totalChars > startChar + maxLength,
    error: result.error,
    handler: "trafilatura",
  };
}
