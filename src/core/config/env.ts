import "dotenv/config";
import { z } from "zod";

/**
 * Validated, immutable application configuration.
 *
 * - Fails fast with a clear message when required configuration is missing.
 * - Secrets are read from the environment only; tenant preferences live in the DB.
 * - Never logs values — only validation errors are surfaced.
 */

const bool = (v: string | undefined) => ["1", "true", "yes"].includes(v ?? "");

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url({ message: "DATABASE_URL must be a valid PostgreSQL connection URL" }),
  DISCORD_BOT_TOKEN: z
    .string()
    .min(20, { message: "DISCORD_BOT_TOKEN is missing or too short" }),
  DISCORD_APPLICATION_ID: z
    .string()
    .regex(/^\d{10,25}$/, { message: "DISCORD_APPLICATION_ID must be a Discord snowflake ID" }),
  DISCORD_PUBLIC_KEY: z.string().optional(),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
  GITHUB_WEBHOOK_PATH: z.string().startsWith("/").default("/api/webhooks/github"),

  PUBLIC_WEBHOOK_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ADMIN_API_TOKEN: z.string().min(16).optional(),

  GROQ_API_KEY: z.string().min(10).optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  AI_MONTHLY_REQUEST_BUDGET: z.coerce.number().int().min(0).default(2000),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  DEFAULT_TIMEZONE: z.string().default("UTC"),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(10).default(90),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  APP_ENCRYPTION_KEY: z.string().optional(),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Environment = z.infer<typeof envSchema>;

export interface AppConfig extends Environment {
  isProduction: boolean;
  encryptionKey?: Buffer;
}

let cached: AppConfig | null = null;

/** True when running under test where full env validation is unnecessary. */
export function isTestEnv(): boolean {
  return bool(process.env.ORBIT_SKIP_ENV_VALIDATION) || process.env.NODE_ENV === "test";
}

export function loadConfig(): AppConfig {
  if (cached) return cached;

  if (isTestEnv()) {
    // Tests run without external systems; components that need specific config
    // construct it explicitly. Provide permissive defaults here.
    cached = {
      ...envSchema.parse({
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/orbit_test",
        DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? "test-token-not-real-0000000000",
        DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID ?? "000000000000000000",
      }),
      isProduction: false,
    };
    return cached;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Fail fast without printing any secret values.
    throw new Error(
      `Invalid Orbit configuration — fix the following and restart:\n${missing}`,
    );
  }
  if (parsed.data.DISCORD_PUBLIC_KEY === "") {
    delete parsed.data.DISCORD_PUBLIC_KEY;
  }

  let encryptionKey: Buffer | undefined;
  if (parsed.data.APP_ENCRYPTION_KEY) {
    const buf = Buffer.from(parsed.data.APP_ENCRYPTION_KEY, "base64");
    if (buf.length !== 32) {
      throw new Error(
        "APP_ENCRYPTION_KEY must decode to exactly 32 bytes (generate with `openssl rand -base64 32`)",
      );
    }
    encryptionKey = buf;
  }

  cached = { ...parsed.data, isProduction: parsed.data.NODE_ENV === "production", encryptionKey };
  return cached;
}

/** Clears the memoized config (used between tests). */
export function resetConfigCache(): void {
  cached = null;
}
