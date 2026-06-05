/**
 * Generic page content extraction via trafilatura (Python CLI).
 *
 * Used as a fallback when no site-specific handler matches.
 */

import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const TRAFILATURA = "/Users/ejx/.pi/.venv/bin/trafilatura";

export async function extractViaTrafilatura(
    url: string,
    startChar: number,
    maxLength: number,
): Promise<{
    text: string;
    totalChars: number;
    error?: string;
}> {
    try {
        const { stdout } = await execFileAsync(
            TRAFILATURA,
            [
                "-u",
                url,
                "--output-format",
                "markdown",
                "--with-metadata",
                "--links",
                "--no-comments",
            ],
            { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );

        const text = stdout.trim();
        if (!text) {
            return {
                text: "",
                totalChars: 0,
                error: "No content extracted. Page may be JS-rendered, behind auth, or have no main article.",
            };
        }

        return {
            text: text.slice(startChar, startChar + maxLength),
            totalChars: text.length,
        };
    } catch (err: any) {
        if (err.code === "ENOENT") {
            return {
                text: "",
                totalChars: 0,
                error: "trafilatura not found. Install it with: uv pip install trafilatura --python /Users/ejx/.pi/.venv/bin/python",
            };
        }
        const stderr = (err.stderr ?? "").toString().trim();
        const stdout = (err.stdout ?? "").toString().trim();
        // Build a useful diagnostic message: stderr first, then stdout if it has
        // content (trafilatura may print errors to stdout), then fall back to
        // exit code + signal since Node's default "Command failed: ..." message
        // hides the actual failure reason.
        let detail = stderr || stdout;
        if (!detail) {
            const parts: string[] = [];
            if (err.code != null) parts.push(`exit code ${err.code}`);
            if (err.signal) parts.push(`signal ${err.signal}`);
            if (parts.length > 0) {
                detail = `Command failed (${parts.join(", ")}). Page may be behind Cloudflare, auth, or blocks automated requests.`;
            } else {
                detail = err.message || String(err);
            }
        }
        return {
            text: "",
            totalChars: 0,
            error: detail,
        };
    }
}
