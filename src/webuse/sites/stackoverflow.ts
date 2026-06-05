/**
 * Stack Overflow / Stack Exchange site handler.
 *
 * Uses the Stack Exchange API for Q&A content including answers.
 * Matches: stackoverflow.com/questions/<id>, <site>.stackexchange.com/questions/<id>
 */

import { stripHtml } from "./utils.js";

export type SiteHandler = (url: string) => Promise<string | null>;

export async function handleStackOverflow(url: string): Promise<string | null> {
    const match = url.match(
        /^(?:https?:\/\/)?(?:(?:stackoverflow|([a-z]+)\.stackexchange)\.com|serverfault\.com|superuser\.com)\/questions\/(\d+)/i,
    );
    if (!match) return null;

    const site = match[1] ? `${match[1]!}.stackexchange` : "stackoverflow";
    const questionId = match[2]!;

    const apiUrl = `https://api.stackexchange.com/2.3/questions/${questionId}?order=desc&sort=votes&site=${site}&filter=withbody`;

    try {
        const res = await fetch(apiUrl, {
            headers: { "User-Agent": "pi-agent/1.0 (web-search extension)" },
        });
        if (!res.ok) return null;

        const data = (await res.json()) as {
            items?: Array<{
                title?: string;
                body?: string;
                score?: number;
                answer_count?: number;
                answers?: Array<{
                    body?: string;
                    score?: number;
                    is_accepted?: boolean;
                }>;
            }>;
        };

        const item = data.items?.[0];
        if (!item) return null;

        const parts: string[] = [];
        parts.push(`# ${item.title}`);
        parts.push(`Score: ${item.score} | Answers: ${item.answer_count}`);
        parts.push("");

        if (item.body) {
            parts.push("## Question\n");
            parts.push(stripHtml(item.body));
            parts.push("");
        }

        // Get answers
        const answersUrl = `https://api.stackexchange.com/2.3/questions/${questionId}/answers?order=desc&sort=votes&site=${site}&filter=withbody`;
        try {
            const ansRes = await fetch(answersUrl, {
                headers: {
                    "User-Agent": "pi-agent/1.0 (web-search extension)",
                },
            });
            if (ansRes.ok) {
                const ansData = (await ansRes.json()) as {
                    items?: Array<{
                        body?: string;
                        score?: number;
                        is_accepted?: boolean;
                    }>;
                };
                if (ansData.items?.length) {
                    parts.push("## Answers\n");
                    for (let i = 0; i < Math.min(ansData.items.length, 5); i++) {
                        const a = ansData.items[i]!;
                        const accepted = a.is_accepted ? " ✓" : "";
                        parts.push(
                            `### Answer ${i + 1} (score: ${a.score}${accepted})\n`,
                        );
                        if (a.body) parts.push(stripHtml(a.body));
                        parts.push("");
                    }
                }
            }
        } catch {
            // fall through
        }

        return parts.join("\n");
    } catch {
        return null;
    }
}
