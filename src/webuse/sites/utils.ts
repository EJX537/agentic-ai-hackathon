/**
 * Shared utilities for site handlers.
 */

/** Strip HTML tags and decode common entities. */
export function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, "") // Remove tags
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
