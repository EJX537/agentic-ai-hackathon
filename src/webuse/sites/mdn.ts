/**
 * MDN Web Docs site handler.
 *
 * Uses the MDN API for clean documentation content.
 * Matches: developer.mozilla.org/<locale>/docs/<path>
 */

import { stripHtml } from "./utils.js";

export type SiteHandler = (url: string) => Promise<string | null>;

export async function handleMDN(url: string): Promise<string | null> {
    // Match: developer.mozilla.org/.../docs/<path>
    const match = url.match(
        /^(?:https?:\/\/)?developer\.mozilla\.org\/([a-z-]+)\/docs\/(.+)$/i,
    );
    if (!match) return null;

    const locale = match[1];
    const docPath = match[2];

    const apiUrl = `https://developer.mozilla.org/api/v1/${locale}/docs/${docPath}`;

    try {
        const res = await fetch(apiUrl, {
            headers: { "User-Agent": "pi-agent/1.0 (web-search extension)" },
        });
        if (!res.ok) return null;

        const data = (await res.json()) as {
            title?: string;
            summary?: string;
            body?: string;
        };

        if (!data.body) return null;

        const parts: string[] = [];
        parts.push(`# ${data.title}`);
        if (data.summary) parts.push(`> ${data.summary}`);
        parts.push("");
        parts.push(stripHtml(data.body));

        return parts.join("\n");
    } catch {
        return null;
    }
}
