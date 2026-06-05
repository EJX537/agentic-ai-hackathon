/**
 * SearXNG search client.
 *
 * Searches the web via the SearXNG metasearch instance at
 * https://searxng.tail02637.ts.net and returns structured results.
 */

const SEARXNG_URL = "https://searxng.tail02637.ts.net";

export interface SearXNGResult {
  url: string;
  title: string;
  content: string;
  engine?: string;
  publishedDate?: string | null;
  category?: string;
  score?: number;
  img_src?: string;
}

export interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  answers?: string[];
  infoboxes?: Array<{
    infobox: string;
    content: string;
    urls?: Array<{ title: string; url: string }>;
  }>;
  suggestions?: string[];
  unresponsive_engines?: string[];
}

export interface SearchOptions {
  query: string;
  pageno?: number;
  time_range?: "day" | "month" | "year";
  language?: string;
  safesearch?: number;
}

/**
 * Execute a SearXNG search.
 * Returns the raw JSON response or throws on error.
 */
export async function searchWeb(opts: SearchOptions): Promise<SearXNGResponse> {
  const url = new URL(`${SEARXNG_URL}/search`);
  url.searchParams.set("q", opts.query);
  url.searchParams.set("format", "json");
  if (opts.pageno && opts.pageno > 1)
    url.searchParams.set("pageno", String(opts.pageno));
  if (opts.time_range)
    url.searchParams.set("time_range", opts.time_range);
  if (opts.language && opts.language !== "all")
    url.searchParams.set("language", opts.language);
  if (opts.safesearch !== undefined)
    url.searchParams.set("safesearch", String(opts.safesearch));

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; web-use-agent/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `SearXNG returned status ${response.status}: ${response.statusText}`,
    );
  }

  return (await response.json()) as SearXNGResponse;
}

/**
 * Format search results as a readable text block for the LLM.
 */
export function formatSearchResults(data: SearXNGResponse): string {
  const results = data.results ?? [];
  const answers = data.answers ?? [];
  const suggestions = data.suggestions ?? [];

  const parts: string[] = [];
  parts.push(
    `Search results for "${data.query}" (${results.length} results)`,
  );
  parts.push("");

  if (answers.length > 0) {
    parts.push("── Answers ──");
    for (const a of answers) parts.push(`  ${a}`);
    parts.push("");
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    parts.push(`${i + 1}. ${r.title}`);
    parts.push(`   ${r.url}`);
    if (r.content) parts.push(`   ${r.content}`);
    const meta: string[] = [];
    if (r.engine) meta.push(`engine: ${r.engine}`);
    if (r.publishedDate) meta.push(`date: ${r.publishedDate}`);
    if (meta.length) parts.push(`   (${meta.join(", ")})`);
    parts.push("");
  }

  if (suggestions.length > 0) {
    parts.push(`Suggestions: ${suggestions.join(", ")}`);
  }

  return parts.join("\n").trim() || "No results found.";
}
