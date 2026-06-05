/**
 * Reddit site handler.
 *
 * Uses RSS feeds for subreddit listings, old.reddit.com (static HTML)
 * for individual post pages via trafilatura.
 */

import { extractViaTrafilatura } from "./trafilatura.js";

export type SiteHandler = (url: string) => Promise<string | null>;

export async function handleReddit(url: string): Promise<string | null> {
    const match = url.match(
        /^(?:https?:\/\/)?(?:(?:www|old)\.)?reddit\.com\/(r\/[^/?#]+(?:\/[^?#]*)?)/i,
    );
    if (!match) return null;

    const path = match[1]!;

    // If it's already an RSS URL, fetch it directly
    if (url.endsWith(".rss")) {
        return fetchAndConvertRss(url);
    }

    // If it's a post URL (contains /comments/), use old.reddit.com for static HTML
    if (/\/comments\//i.test(path)) {
        const oldUrl = `https://old.reddit.com/${path}`;
        const fallback = await extractViaTrafilatura(oldUrl, 0, 8000);
        if (fallback.text && !fallback.error) {
            const parts: string[] = [];
            parts.push(`# Reddit Post (via old.reddit.com)`);
            parts.push(`Source: ${oldUrl}`);
            parts.push("");
            parts.push(fallback.text);
            return parts.join("\n");
        }
        return null;
    }

    // For subreddit listings, use RSS
    const rssUrl = `https://www.reddit.com/${path.replace(/\/+$/, "")}.rss`;
    return fetchAndConvertRss(rssUrl);
}

async function fetchAndConvertRss(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "pi-agent/1.0 (web-search extension)",
            },
        });
        if (!res.ok) return null;

        const xml = await res.text();

        const parts: string[] = [];
        parts.push(`# Reddit Feed`);
        parts.push(`Source: ${url}`);
        parts.push("");

        // Extract <entry> elements (Atom) or <item> elements (RSS 2.0)
        const entries = xml.match(
            /<(?:entry|item)>[\s\S]*?<\/(?:entry|item)>/gi,
        );
        if (!entries) {
            parts.push("No entries found in feed.");
            return parts.join("\n");
        }

        for (let i = 0; i < Math.min(entries.length, 25); i++) {
            const entry = entries[i]!;

            const title = extractXmlTag(entry, "title");
            const content =
                extractXmlTag(entry, "content") ||
                extractXmlTag(entry, "description");
            const link = extractXmlTag(entry, "link");
            const author =
                extractXmlTag(entry, "author") ||
                extractXmlTag(entry, "name");
            const updated =
                extractXmlTag(entry, "updated") ||
                extractXmlTag(entry, "pubDate");

            if (!title && !content) continue;

            parts.push(`---`);
            if (title) parts.push(`## ${title}`);
            if (author) parts.push(`**${author}**`);
            if (updated) parts.push(`*${updated}*`);
            if (content) {
                const clean = content
                    .replace(/<[^>]*>/g, "")
                    .replace(/&amp;/g, "&")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&#(\d+);/g, (_, n) =>
                        String.fromCodePoint(Number(n)),
                    )
                    .trim();
                if (clean) parts.push(clean.slice(0, 1000));
            }
            if (link && !link.startsWith("http")) {
                const hrefMatch = entry.match(/<link[^>]+href="([^"]+)"/i);
                if (hrefMatch) parts.push(`Link: ${hrefMatch[1]!}`);
            } else if (link) {
                parts.push(`Link: ${link}`);
            }
        }

        return parts.join("\n");
    } catch {
        return null;
    }
}

function extractXmlTag(xml: string, tag: string): string | null {
    const match = xml.match(
        new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
    );
    return match ? match[1]!.trim() : null;
}
