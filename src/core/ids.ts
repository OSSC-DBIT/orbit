import { randomBytes } from "node:crypto";

/** Correlation identifiers for tracing work across modules and log lines. */

export function newCorrelationId(prefix = "cor"): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** Deterministic short fingerprint for deduplication and idempotency keys. */
export function fingerprintOf(parts: string[]): string {
  // FNV-1a 64-bit — deterministic across processes, no collision concerns at our scale.
  let h = 0xcbf29ce484222325n;
  for (const part of parts) {
    const s = part.toLowerCase().replace(/\s+/g, " ").trim();
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i));
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    h ^= 0x9e3779b97f4a7c15n;
  }
  return h.toString(36);
}
