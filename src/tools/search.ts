/**
 * Search Tool — Mock implementation.
 *
 * Actual Phase 2 will use:
 *   - Tavily AI (primary)
 *   - SearXNG metasearch (fallback)
 *
 * For now returns canned results so the pipeline compiles and runs.
 */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults?: number;
}

/**
 * Search the web for a query.
 *
 * @returns An array of search results with url, title, and snippet.
 */
export async function searchWeb(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const max = options.maxResults ?? 5;

  console.log(`[Search:MOCK] Searching for "${query}" (max=${max})`);

  // ── Mock results ──────────────────────────────────────────────────
  const mockResults: SearchResult[] = [
    {
      url: "https://example.com/result-1",
      title: `Example result 1 for "${query}"`,
      snippet: `This is a mock search result for "${query}". It contains example content that a real search would return.`,
    },
    {
      url: "https://example.com/result-2",
      title: `Example result 2 for "${query}"`,
      snippet: `Another mock result for "${query}". Real implementation would use Tavily AI or SearXNG.`,
    },
    {
      url: "https://example.com/result-3",
      title: `Example result 3 for "${query}"`,
      snippet: `A third mock result showing what the search integration will look like when powered by Tavily or SearXNG.`,
    },
  ];

  return mockResults.slice(0, max);
}
