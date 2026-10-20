import { ExternalServiceError, RateLimitedError } from "./errors/index.js";
import { redactString } from "./security/redact.js";

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  backoffBaseMs?: number;
  /** Max accepted response size (default 5 MB). */
  maxBytes?: number;
  headers?: Record<string, string>;
  /** Simple client-side rate limit: max `requests` per `windowMs` (default off). */
  rateLimit?: { requests: number; windowMs: number };
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
}

interface RateBucket {
  timestamps: number[];
}

const buckets = new Map<string, RateBucket>();

async function acquireRateLimit(key: string, limit: { requests: number; windowMs: number }): Promise<void> {
  const bucket = buckets.get(key) ?? { timestamps: [] };
  const cutoff = () => Date.now() - limit.windowMs;
  const evict = () => {
    bucket.timestamps = bucket.timestamps.filter((t) => t >= cutoff());
  };
  evict();
  if (bucket.timestamps.length >= limit.requests) {
    const waitMs = limit.windowMs - (Date.now() - bucket.timestamps[0]!) + 50;
    await delay(Math.max(waitMs, 0));
    evict();
  }
  bucket.timestamps.push(Date.now());
  buckets.set(key, bucket);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch() with timeout, bounded retries + jitter, size cap and rate limiting. */
export async function httpFetch(url: string, options: FetchOptions = {}): Promise<HttpResponse> {
  const {
    timeoutMs = 15_000,
    retries = 2,
    backoffBaseMs = 400,
    maxBytes = 5 * 1024 * 1024,
    headers = {},
    rateLimit,
  } = options;

  if (rateLimit) {
    await acquireRateLimit(`${url.split("?")[0] ?? url}`, rateLimit);
  }

  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = retries + 1;

  while (attempt < maxAttempts) {
    if (attempt > 0) {
      const jitter = Math.random() * backoffBaseMs * 0.3;
      await delay(backoffBaseMs * 2 ** attempt + jitter);
    }
    attempt++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            "user-agent": "OrbitBot/0.1 (+https://github.com/orbit-intel)",
            accept: "application/json, text/xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
            ...headers,
          },
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        lastError = new ExternalServiceError(`HTTP ${response.status}`, `status=${response.status} url=${redactString(url)}`);
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after") ?? "");
          if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 120) {
            await delay(retryAfter * 1000);
          }
        }
        continue;
      }

      const headersMap: Record<string, string> = {};
      response.headers.forEach((v, k) => (headersMap[k] = v));
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) {
        throw new ExternalServiceError(
          "response too large",
          `response from ${redactString(url)} exceeded ${maxBytes} bytes`,
        );
      }
      return { status: response.status, ok: response.ok, text, headers: headersMap };
    } catch (err) {
      if (err instanceof ExternalServiceError || err instanceof RateLimitedError) throw err;
      lastError = err;
      // Retry network errors; give up when attempts exhausted.
      if (attempt >= maxAttempts) break;
    }
  }

  if (lastError instanceof ExternalServiceError) throw lastError;
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ExternalServiceError("network", redactString(detail), { cause: lastError });
}

export async function httpJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await httpFetch(url, options);
  if (!response.ok) {
    throw new ExternalServiceError(`HTTP ${response.status}`, `request to ${redactString(url)} failed with ${response.status}`);
  }
  try {
    return JSON.parse(response.text) as T;
  } catch (err) {
    throw new ExternalServiceError("unparseable JSON", redactString(url), { cause: err });
  }
}
