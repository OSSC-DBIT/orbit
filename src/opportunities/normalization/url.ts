/**
 * URL canonicalization for deduplication.
 * Lowers scheme/host, strips tracking params & fragments, normalizes trailing
 * slashes and default ports, then produces the key used for URL-based dedup.
 */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_eid",
  "mc_cid",
  "ref",
  "referrer",
  "igshid",
  "si",
  "trk",
  "attribution_id",
  "feature",
]);

const PORT_DEFAULTS: Record<string, string> = { "https:": "443", "http:": "80" };

export function canonicalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;

  url.hash = "";
  url.username = "";
  url.password = "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const proto = url.protocol;
  const port = url.port && url.port !== PORT_DEFAULTS[proto] ? `:${url.port}` : "";
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.append(key, value);
  }
  kept.sort();
  const query = kept.toString();

  return `${proto}//${host}${port}${pathname}${query ? `?${query}` : ""}`;
}

/** Extracts likely-tracked clean url from devpost-style "//domain/..." refs. */
export function normalizeProtocolRelative(input: string | null | undefined): string | null {
  return canonicalizeUrl(input);
}

/** Splits a canonical URL into host + path for similarity comparison. */
export function urlSimilarityKey(a: string | null, b: string | null): boolean {
  const ca = canonicalizeUrl(a);
  const cb = canonicalizeUrl(b);
  if (!ca || !cb) return false;
  return stripQuery(ca) === stripQuery(cb);
}

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}
