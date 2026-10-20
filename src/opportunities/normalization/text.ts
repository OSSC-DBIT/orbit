/**
 * Text normalization helpers: HTML stripping, whitespace squashing, tag
 * extraction, skill extraction and sane truncation. All inputs are treated as
 * untrusted data — descriptions are never parsed as instructions.
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const num = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        if (Number.isFinite(num) && num > 0 && num < 0x110000) {
          try {
            return String.fromCodePoint(num);
          } catch {
            return "";
          }
        }
        return "";
      }
      return HTML_ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/&[a-z]+;/gi, (m) => m); // unknown entities left alone
}

/** Removes script/style, replaces block tags with newlines, strips all tags. */
export function stripHtml(html: string, maxLength = 2000): { text: string; html: string } {
  const cleanedHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(cleanedHtml);
  const squashed = decoded
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/\n +/g, "\n")
    .trim();
  return { text: truncate(squashed, maxLength), html: truncate(html, 2000) };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}'"()&+#. -]/gu, "")
    .trim();
}

const NOISE_SUFFIXES = [
  /\(.*20\d{2}\)$/i,
  /\brounds?\s*\d+\b/i,
  /\bround\b/i,
];

/** Normalized title+org used for cross-source similarity. */
export function similarityKey(title: string, organization: string | null): string {
  let t = normalizeTitle(title);
  for (const re of NOISE_SUFFIXES) t = t.replace(re, "");
  const org = organization ? normalizeTitle(organization) : "";
  return `${t}::${org}`.replace(/\s+/g, "");
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "you", "your", "are", "will", "have", "this", "that", "from",
  "apply", "now", "new", "all", "about", "into", "join", "get", "use", "via",
]);

/** Extracts up to 12 keyword-ish tags from title + description. */
export function extractTags(title: string, description: string | null): string[] {
  const source = `${title} ${description ?? ""}`;
  const words = source
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+# ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);
}

const KNOWN_SKILLS = [
  "javascript", "typescript", "python", "java", "c++", "c#", "go", "rust", "kotlin", "swift",
  "ruby", "php", "scala", "sql", "react", "angular", "vue", "node", "django", "flask", "spring",
  "aws", "azure", "gcp", "golang", "docker", "kubernetes", "terraform", "graphql", "postgresql",
  "mysql", "mongodb", "redis", "kafka", "machine learning", "ml", "ai", "nlp", "llm", "devops",
  "android", "ios", "flutter", "react native", "unity", "blockchain", "solidity", "web3",
  "data science", "cybersecurity", "linux", "next.js", "svelte", "sveltekit", "tailwind",
];

/** Case-insensitive skill detection against a known list. */
export function extractSkills(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const found = KNOWN_SKILLS.filter((skill) => lower.includes(` ${skill} `) || lower.includes(` ${skill},`) || lower.includes(` ${skill}.`) || lower.includes(` ${skill}s `));
  return found.slice(0, 20);
}

export function inferRemoteStatus(text: string, location: string | null): "remote" | "onsite" | "hybrid" | null {
  const lower = text.toLowerCase();
  if (/\bremote\b|\bvirtual\b|\bwork from anywhere\b|\bonline( only)?\b|\bglobal\b/.test(lower)) return "remote";
  if (/\bhybrid\b/.test(lower)) return "hybrid";
  if (location && location.trim().length > 0) {
    if (/\bremote\b/i.test(location)) return "remote";
    return "onsite";
  }
  return null;
}
