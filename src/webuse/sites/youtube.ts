/**
 * YouTube site handler.
 *
 * Uses oEmbed for video metadata, then falls back to trafilatura
 * for any extractable content (transcripts, descriptions).
 */

import { extractViaTrafilatura } from "./trafilatura.js";

export type SiteHandler = (url: string) => Promise<string | null>;

export async function handleYouTube(url: string): Promise<string | null> {
    const match = url.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    );
    if (!match) return null;

    const videoId = match[1];

    const parts: string[] = [];
    parts.push(`# YouTube Video: ${videoId}\n`);

    // Try oEmbed for metadata
    try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        const res = await fetch(oembedUrl, {
            headers: { "User-Agent": "pi-agent/1.0 (web-search extension)" },
        });
        if (res.ok) {
            const data = (await res.json()) as {
                title?: string;
                author_name?: string;
                author_url?: string;
                thumbnail_url?: string;
            };
            if (data.title) parts.push(`**${data.title}**`);
            if (data.author_name) parts.push(`By: ${data.author_name}`);
            parts.push(`URL: https://www.youtube.com/watch?v=${videoId}`);
        }
    } catch {
        // fall through
    }

    // Try to get page content via trafilatura
    const fallback = await extractViaTrafilatura(url, 0, 8000);
    if (fallback.text && !fallback.error) {
        parts.push("\n## Extracted Content\n");
        parts.push(fallback.text);
    } else {
        parts.push(
            "\n> No transcript available. Use the URL to visit the video directly.",
        );
    }

    return parts.join("\n");
}
