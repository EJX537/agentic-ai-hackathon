/**
 * GitHub site handler.
 *
 * Handles both github.com/blob/... and raw.githubusercontent.com URLs.
 * Converts blob URLs to raw, or fetches raw URLs directly.
 * Wraps source code in code fences.
 */

export type SiteHandler = (url: string) => Promise<string | null>;

const codeExtensions = new Set([
    "ts", "js", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp",
    "h", "hpp", "rb", "php", "swift", "kt", "scala", "hs", "ml",
    "sh", "bash", "zsh", "yaml", "yml", "json", "toml", "xml",
    "html", "css", "scss", "sql", "r", "m", "dart", "lua", "ex", "exs",
]);

// Files without extensions that are still code-like
const codeFiles = new Set([
    "Makefile", "Dockerfile", "Jenkinsfile", "Vagrantfile", "Gemfile",
    "Rakefile", "Procfile", "Brewfile", "Justfile",
]);

function getFileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? "";
}

function getLangHint(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (codeExtensions.has(ext)) return ext;
    const name = getFileName(path);
    if (codeFiles.has(name)) {
        const lang: Record<string, string> = {
            Makefile: "makefile",
            Dockerfile: "dockerfile",
            Jenkinsfile: "groovy",
            Vagrantfile: "ruby",
            Gemfile: "ruby",
            Rakefile: "ruby",
            Procfile: "yaml",
            Brewfile: "ruby",
            Justfile: "makefile",
        };
        return lang[name] ?? "";
    }
    return "";
}

async function fetchRaw(rawUrl: string, path: string): Promise<string | null> {
    try {
        const res = await fetch(rawUrl, {
            headers: { "User-Agent": "pi-agent/1.0 (web-search extension)" },
        });
        if (!res.ok) return null;

        const text = await res.text();
        const lang = getLangHint(path);

        if (lang) {
            return `\`\`\`${lang}\n${text}\n\`\`\``;
        }
        return text;
    } catch {
        return null;
    }
}

export async function handleGitHub(url: string): Promise<string | null> {
    // Strip fragment and query params before matching
    const cleanUrl = url.replace(/[?#].*$/, "");

    // ── raw.githubusercontent.com URLs ──────────────────────────
    const rawMatch = cleanUrl.match(
        /^(?:https?:\/\/)?raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i,
    );
    if (rawMatch) {
        const [, , , , path] = rawMatch;
        return fetchRaw(cleanUrl, path!);
    }

    // ── github.com/blob/... URLs ────────────────────────────────
    const blobMatch = cleanUrl.match(
        /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i,
    );
    if (blobMatch) {
        const [, owner, repo, branch, path] = blobMatch;
        const rawUrl = `https://raw.githubusercontent.com/${owner!}/${repo!}/${branch!}/${path!}`;
        return fetchRaw(rawUrl, path!);
    }

    return null;
}
