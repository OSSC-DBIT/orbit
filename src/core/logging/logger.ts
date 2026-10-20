import pino, { type Logger as PinoLogger } from "pino";
import { loadConfig } from "../config/env.js";
import { redactDeep, redactString } from "../security/redact.js";

/**
 * Structured JSON logging with secret redaction.
 *
 * Tenant/scoping fields go into `context` — they are part of the log line,
 * not secret material: guildId, sourceId, correlationId, jobId, repo.
 */

let rootLogger: PinoLogger | null = null;

export async function initLogging(): Promise<PinoLogger> {
  if (rootLogger) return rootLogger;
  const config = loadConfig();
  rootLogger = pino({
    level: config.LOG_LEVEL,
    base: { app: "orbit", env: config.NODE_ENV },
    redact: {
      // Belt and braces: pino's own redaction plus our pattern-based one.
      paths: [
        "token",
        "password",
        "authorization",
        "secret",
        "apiKey",
        "api_key",
        "*.token",
        "*.password",
        "*.authorization",
      ],
      censor: "[REDACTED]",
    },
    // single-line JSON log format, timestamps in UTC
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    hooks: {
      // Apply pattern-based redaction to human written message strings.
      logMethod(inputArgs, method) {
        const [first, ...rest] = inputArgs;
        if (typeof first === "string") {
          return method.apply(this, [redactString(first), ...rest]);
        }
        return method.apply(this, inputArgs);
      },
    },
  });
  return rootLogger;
}

/** Logger for early startup (before config loads) — no DB, no secrets. */
export function bootstrapLogger(): PinoLogger {
  if (rootLogger) return rootLogger;
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    formatters: { level(label) { return { level: label }; } },
  });
}

export function getLogger(): PinoLogger {
  if (!rootLogger) return bootstrapLogger();
  return rootLogger;
}

export type OrbitLogger = PinoLogger;

export interface LogContext {
  guildId?: string;
  tenant?: string;
  correlationId?: string;
  sourceId?: string;
  jobId?: string;
  deliveryId?: string;
  repo?: string;
  userId?: string;
  error?: unknown;
  [key: string]: unknown;
}

/** Child logger carrying tenant-aware context (values are redacted first). */
export function scopedLogger(base: PinoLogger, context: LogContext): PinoLogger {
  return base.child(redactDeep(context) as Record<string, unknown>);
}

export async function closeLogging(): Promise<void> {
  const logger = rootLogger;
  rootLogger = null;
  if (logger && typeof logger.flush === "function") {
    try {
      await logger.flush();
    } catch {
      // ignore flush failures during shutdown
    }
  }
}
