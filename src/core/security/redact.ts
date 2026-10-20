/**
 * Secret redaction. Applied to: log lines, workflow logs, error payloads, and
 * anything that will be stored or transmitted outside the process boundary.
 *
 * Two mechanisms:
 *  1. Key-based redaction for structured objects (password/token/secret/…).
 *  2. Pattern-based redaction for free text (logs, descriptions).
 */

const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "privatekey",
  "private_key",
  "authorization",
  "auth",
  "cookie",
  "session",
  "credential",
  "signature",
  "webhook_secret",
];

const KEY_PATTERNS = [
  /\bghp_[A-Za-z0-9]{36,}\b/g, // classic PAT
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // fine-grained PAT
  /\bgho_[A-Za-z0-9]{36,}\b/g, // OAuth token
  /\bghs_[A-Za-z0-9]{36,}\b/g, // installation token
  /\bghu_[A-Za-z0-9]{36,}\b/g,
  /\bMT[A-Za-z0-9_.-]{50,}\b/g, // discord token (prefix MT/ND/OD encoded base64)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // slack
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // openai-style
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // groq
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWTs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\bbasic\s+[A-Za-z0-9+/=]{16,}\b/gi,
  /(?:password|passwd|pwd|secret)\s*[:=]\s*\S+/gi,
  /(?:token|key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
];

export const REDACTED = "[REDACTED]";

/** Free-text redaction for logs and untrusted content. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, (match) => truncateRedaction(match));
  }
  // URLs carrying credentials: postgres://user:pass@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@\s]+(@)/gi, "$1" + REDACTED + "$2");
  return out;
}

function truncateRedaction(match: string): string {
  // Keep short noise like `token: x` readable but still neutralized.
  if (match.length > 24) return REDACTED;
  return match.slice(0, Math.max(0, match.indexOf(":") + 1)) + REDACTED;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/** Deep-walks a JSON-like structure and redacts sensitive keys' values. Cycle-safe. */
export function redactDeep<T>(value: T, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return REDACTED;
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactString(value) : value;
  }
  if (seen.has(value as object)) return "[CYCLIC]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactDeep(v, depth + 1, seen);
    }
  }
  return out;
}
