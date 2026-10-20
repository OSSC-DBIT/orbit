import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { runMigrations } from "../../src/database/migrate.js";
import { getDb, withSystemContext, withTenant, closeDb } from "../../src/database/client.js";
import {
  auditLogs,
  deadlineNotifications,
  guildFeatureSettings,
  opportunityDeliveries,
} from "../../src/database/schema/index.js";
import { TenantService } from "../../src/tenants/services/tenant-service.js";

/**
 * Database integration tests.
 *
 * They run only when ORBIT_TEST_DATABASE_URL points at a throwaway Postgres
 * (16+) database, e.g.:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   ORBIT_TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/postgres
 *
 * Without it the suite skips gracefully so `npm test` works anywhere.
 */

const ORBIT_TEST_DATABASE_URL = process.env.ORBIT_TEST_DATABASE_URL ?? null;
const guildA = "700000000000000001";
const guildB = "700000000000000002";
const auditGuildC = "700000000000000003";

const d = ORBIT_TEST_DATABASE_URL ? describe : describe.skip;

d("database: migrations, RLS and tenant isolation", () => {
  let svc: TenantService;

  /** Derives the application-role URL from the admin test connection. */
  const appUrl = (): string => {
    const u = new URL(ORBIT_TEST_DATABASE_URL!);
    u.username = "orbit_app";
    u.password = "orbit_app_pw";
    return u.toString();
  };

  const cleanupGuilds = async (): Promise<void> => {
    // deletions need the bypass sentinel so they cover all tenants
    await withSystemContext((tx) =>
      (async () => {
        await tx.delete(deadlineNotifications).where(sql`guild_id in (${guildA}, ${guildB}, ${auditGuildC})`);
        await tx.delete(opportunityDeliveries).where(sql`guild_id in (${guildA}, ${guildB}, ${auditGuildC})`);
        await tx.delete(auditLogs).where(sql`guild_id in (${guildA}, ${guildB}, ${auditGuildC})`);
        await tx.delete(guildFeatureSettings).where(sql`guild_id in (${guildA}, ${guildB}, ${auditGuildC})`);
      })(),
    );
  };

  beforeAll(async () => {
    // 1. migrations run as the admin role (DDL)
    process.env.DATABASE_URL = ORBIT_TEST_DATABASE_URL!;
    await runMigrations();

    // 2. bootstrap a dedicated NON-superuser application role: superusers and
    //    owners without FORCE RLS bypass row security, so the production-shape
    //    role is what the isolation assertions must run as.
    const adminDb = getDb();
    for (const statement of [
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'orbit_app') then
           create role orbit_app login password 'orbit_app_pw' nosuperuser;
         end if;
       end $$;`,
      "grant usage on schema public to orbit_app",
      "grant select, insert, update, delete on all tables in schema public to orbit_app",
      "grant usage, select on all sequences in schema public to orbit_app",
    ]) {
      await adminDb.execute(sql.raw(statement));
    }

    // 3. reconnect as the application role for all tenant assertions
    await closeDb();
    process.env.DATABASE_URL = appUrl();
    await cleanupGuilds();
    svc = new TenantService(getDb());
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupGuilds();
    } catch {
      /* best effort cleanup */
    }
    await closeDb();
  });

  it("applies schema migrations and the tenant RLS policies", async () => {
    const res = await getDb().execute(
      sql`select count(*)::int as n from information_schema.tables where table_name = 'discord_guilds'`,
    );
    expect((res.rows[0] as { n: number }).n).toBe(1);
    const policies = await getDb().execute(
      sql`select count(*)::int as n from pg_policies where tablename = 'guild_feature_settings' and policyname = 'tenant_isolation_guild_feature_settings'`,
    );
    expect((policies.rows[0] as { n: number }).n).toBe(1);
  });

  it("records the migration ledger", async () => {
    const res = await getDb().execute(sql`select count(*)::int as n from _orbit_migrations`);
    expect((res.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("seeds default preferences per guild on first contact", async () => {
    await svc.ensureGuild(guildA, "Guild A");
    const prefs = await svc.getPreferences(guildA);
    expect(prefs.guildId).toBe(guildA);
    expect(prefs.digestHours).toEqual([9]);
    expect(prefs.remoteOnly).toBe(false);
  });

  it("scopes row visibility per tenant (guild A never sees guild B rows)", async () => {
    await withSystemContext(async (tx) => {
      await tx.insert(guildFeatureSettings).values({ guildId: guildA, feature: "digest", enabled: 1 });
      await tx.insert(guildFeatureSettings).values({ guildId: guildB, feature: "digest", enabled: 1 });
    });

    const seenByA = await withTenant(guildA, async (tx) =>
      tx.select().from(guildFeatureSettings).where(sql`guild_id = ${guildA}`),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.guildId).toBe(guildA);

    // The RLS policy hides rows of other tenants even without a user filter.
    const withoutFilter = await withTenant(guildA, (tx) => tx.select().from(guildFeatureSettings));
    expect(withoutFilter.every((r) => r.guildId === guildA)).toBe(true);
  });

  it("refuses cross tenant writes through the with-check policy", async () => {
    await expect(
      withTenant(guildA, async (tx) =>
        tx.insert(guildFeatureSettings).values({ guildId: guildB, feature: "opportunities", enabled: 1 }),
      ),
    ).rejects.toThrow();
  });

  it("enforces the no-repetition delivery uniqueness invariant", async () => {
    const row = { guildId: guildA, opportunityId: 990001, channelId: "ch-1", deliveryKind: "instant" };
    const first = await withSystemContext((tx) =>
      tx.insert(opportunityDeliveries).values(row).onConflictDoNothing().returning({ id: opportunityDeliveries.id }),
    );
    const second = await withSystemContext((tx) =>
      tx.insert(opportunityDeliveries).values(row).onConflictDoNothing().returning({ id: opportunityDeliveries.id }),
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // unique (guild, opportunity, channel, kind) blocks re-announcing
  });

  it("enforces deadline reminder uniqueness per (guild, opportunity, offset)", async () => {
    const row = {
      guildId: guildB,
      opportunityId: 990002,
      offsetMinutes: 1440,
      scheduledFor: new Date(Date.now() + 3600_000),
    };
    const first = await withSystemContext((tx) =>
      tx.insert(deadlineNotifications).values(row).onConflictDoNothing().returning({ id: deadlineNotifications.id }),
    );
    const second = await withSystemContext((tx) =>
      tx.insert(deadlineNotifications).values(row).onConflictDoNothing().returning({ id: deadlineNotifications.id }),
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("keeps audit logs tenant scoped", async () => {
    await svc.ensureGuild(auditGuildC);
    await svc.recordAudit(auditGuildC, "runner", "test.action", { note: "integration" });
    const log = await svc.getAuditLog(auditGuildC, 10);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.action).toBe("test.action");
    expect(log[0]!.actorId).toBe("runner");
  });
});
