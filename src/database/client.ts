import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { tenantRlsStatements } from "./schema/index.js";

export type Database = NodePgDatabase<Record<string, never>>;

/** Sentinel GUC value that grants cross-tenant scope to system jobs only. */
export const SYSTEM_TENANT_CONTEXT = "__system__";

let pgPool: Pool | null = null;
let cachedDb: Database | null = null;

/** Creates (memoized) the postgres pool + drizzle wrapper. */
export function getDb(): Database {
  if (cachedDb) return cachedDb;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required to obtain a database connection");
  pgPool = new Pool({
    connectionString: dbUrl,
    max: 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    // Session default for this pool: system scope. System-triggered jobs
    // (collector, scheduler, webhooks, retention) run here; tenant-facing
    // operations explicitly call withTenant() which overrides the setting
    // transaction-locally, so context never leaks across pooled connections.
    options: `-c app.guild_id=${SYSTEM_TENANT_CONTEXT}`,
  });
  cachedDb = drizzle(pgPool, { casing: "snake_case" });
  return cachedDb;
}

/** For tests / migration tooling. */
export function setDb(db: Database): void {
  cachedDb = db;
}

export async function closeDb(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
    cachedDb = null;
  }
}

/**
 * Runs `fn` inside a transaction with a tenant-safe RLS context.
 *
 * The GUC is set with `set_config(..., true)` = transaction-local, so the
 * pooled connection resets to "no tenant" on commit/rollback — context can't
 * leak across pooled connections.
 *
 * Note: the DB role that Orbit connects with must have BYPASSRLS disabled so
 * these policies hold. FORCE ROW LEVEL SECURITY applies to the table owner.
 */
export async function withTenant<T>(
  guildId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.guild_id', ${guildId}, true)`);
    return fn(tx as Database);
  });
}

/** Cross-tenant context for system jobs (scheduler, collectors) via elevated role. */
export async function withSystemContext<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    // explicit system context for jobs that legitimately need cross-tenant scope
    await tx.execute(sql`select set_config('app.guild_id', ${SYSTEM_TENANT_CONTEXT}, true)`);
    return fn(tx as Database);
  });
}

/**
 * Applies RLS + tenant policies. Called by the migration runner after schema
 * migrations succeed. Returns the statement list applied.
 */
export async function ensureTenantRlsStatements(): Promise<string[]> {
  return tenantRlsStatements();
}
