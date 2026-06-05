/**
 * Wikipedia site handler.
 *
 * Uses the Wikipedia REST API for clean article summaries.
 * Matches: <lang>.wikipedia.org/wiki/<title>
 */

export type SiteHandler = (url: string) => Promise<string | null>;

export async function handleWikipedia(url: string): Promise<string | null> {
    const match = url.match(
        /^(?:https?:\/\/)?([a-z]+)\.wikipedia\.org\/wiki\/(.+)$/i,
    );
    if (!match) return null;

    const lang = match[1]!;
    const title = decodeURIComponent(match[2]!).replace(/_/g, " ");

    const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

    try {
        const res = await fetch(apiUrl, {
            headers: { "User-Agent": "pi-agent/1.0 (web-search extension)" },
        });
        if (!res.ok) return null;

        const data = (await res.json()) as {
            title?: string;
            extract?: string;
            extract_html?: string;
            description?: string;
            thumbnail?: { source?: string };
            content_urls?: { desktop?: { page?: string } };
        };

        if (!data.extract) return null;

        const parts: string[] = [];
        parts.push(`# ${data.title}`);
        if (data.description) parts.push(`> ${data.description}`);
        parts.push("");
        parts.push(data.extract);
        parts.push("");
        parts.push("---");
        parts.push(`Source: ${data.content_urls?.desktop?.page ?? url}`);

        return parts.join("\n");
    } catch {
        return null;
    }
}
