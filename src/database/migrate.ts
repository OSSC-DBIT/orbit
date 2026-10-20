import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { tenantRlsStatements } from "./schema/index.js";
import { bootstrapLogger } from "../core/logging/logger.js";

/**
 * Minimal, deterministic migration runner:
 *  - all migrations are SQL files in drizzle/ named `NNNN_*.sql`
 *  - they run inside one transaction each, in lexicographic order
 *  - the runner then installs tenant RLS policies (idempotent)
 *
 * `npm run db:generate` (drizzle-kit) emits `NNNN_*.sql` from the schema;
 * hand-written RLS additions live in `drizzle/templates/`.
 */

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

export async function runMigrations(
  migrationsDir: string = MIGRATIONS_DIR,
  applyRls = true,
): Promise<MigrationResult> {
  const log = bootstrapLogger();
  const db = getDb();
  await db.execute(sql`
    create table if not exists _orbit_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const appliedRows = (await db.execute(sql`select name from _orbit_migrations`)) as unknown as {
    rows: Array<{ name: string }>;
  };
  const applied = new Set(appliedRows.rows.map((r) => r.name));

  let files: string[] = [];
  try {
    files = (await readdir(migrationsDir))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
  } catch {
    log.warn({ dir: migrationsDir }, "migrations directory missing — skipping file migrations");
  }

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    if (applied.has(file)) {
      result.alreadyApplied.push(file);
      continue;
    }
    const content = await readFile(path.join(migrationsDir, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(content));
      await tx.execute(sql`insert into _orbit_migrations (name) values (${file})`);
    });
    result.applied.push(file);
    log.info({ migration: file }, "migration applied");
  }

  if (applyRls) {
    await db.transaction(async (tx) => {
      for (const statement of tenantRlsStatements()) {
        await tx.execute(sql.raw(statement));
      }
    });
    log.info("tenant RLS policies ensured");
  }

  return result;
}

// Standalone: `npm run db:migrate` (tsx) or `node dist/database/migrate.js` (built)
const isDirectRun =
  process.argv[1] !== undefined && /migrate\.[cm]?[jt]s$/.test(process.argv[1]) && !process.env.VITEST;
if (isDirectRun) {
  await runMigrations().then(
    (r) => {
      console.log(JSON.stringify({ applied: r.applied, already: r.alreadyApplied.length }));
      process.exit(0);
    },
    (err: unknown) => {
      console.error("migration failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
