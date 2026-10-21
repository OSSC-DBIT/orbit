/**
 * Orbit process entrypoint: HTTP surface + Discord gateway + job scheduler.
 *
 * Startup order matters: config validation fails fast; the HTTP server comes
 * up before the gateway so health probes turn green while Discord reconnects;
 * the scheduler starts last so a fresh boot never races a takeover claim.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { loadConfig } from "./core/config/env.js";
import { getLogger, closeLogging, scopedLogger } from "./core/logging/logger.js";
import { getDb, closeDb } from "./database/client.js";
import { TenantService } from "./tenants/services/tenant-service.js";
import { DeliveryService } from "./opportunities/delivery/delivery-service.js";
import { InfraService, severityColor } from "./monitoring/infra.js";
import { Collector } from "./opportunities/collectors/collector.js";
import { ensureDefaultSources } from "./opportunities/connectors/registry.js";
import { AiEngine } from "./ai/services/engine.js";
import { Scheduler } from "./jobs/scheduler.js";
import {
  claimSourceRun,
  registerJobHandlers,
  recurringIntervals,
  runConnectorAndFanout,
} from "./jobs/handlers.js";
import { buildApiServer, registerSyncHandler } from "./api/server.js";
import { startDiscordClient, registerCommands } from "./bot/client.js";
import { DiscordTargetResolver } from "./bot/channel-resolver.js";
import type { CommandDeps } from "./bot/commands/context.js";
import { gauge } from "./observability/metrics.js";

async function main(): Promise<void> {
  const config = loadConfig(); // fails fast with actionable message
  const log = scopedLogger(getLogger(), { tenant: "boot" });
  const db = getDb();

  await ensureDefaultSources(db);

  const tenant = new TenantService(db);
  const ai = AiEngine.fromEnv();
  const collector = new Collector(db);
  const delivery = new DeliveryService(db, null); // resolver attaches post-gateway
  const infra = new InfraService(db); // announcer attaches post-gateway

  const deps: CommandDeps = {
    tenant,
    delivery,
    config,
    db,
    ai,
    collector,
    infra,
  };

  // Discord gateway
  const bot = await startDiscordClient(deps, config);
  const resolver = new DiscordTargetResolver(bot.client, tenant);
  delivery.setTargets(resolver);

  // Project monitoring announcements: the project's own channel first, the
  // guild infrastructure binding as fallback; events are always stored even
  // when no target exists.
  infra.setAnnouncer(async (e) => {
    if (!(await tenant.isFeatureEnabled(e.host.guildId, "infrastructure_alerts"))) return null;
    const target =
      e.host.notifyChannelId ?? (await resolver.resolve("infrastructure", e.host.guildId))?.id ?? null;
    if (!target) return null;
    const channel = resolver.toDiscordChannel(target, e.host.guildId);
    if (!channel) return null;
    await channel.send({
      embeds: [
        {
          title: `${e.host.name} status`,
          description: e.message.slice(0, 4000),
          color: severityColor(e.severity),
          footer: { text: "Orbit project monitoring" },
          timestamp: e.occurredAt.toISOString(),
        },
      ],
      allowedMentions: { parse: [] },
    });
    return target;
  });

  if (process.env.DISCORD_REGISTER_COMMANDS !== "0") {
    try {
      const registered = await registerCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_BOT_TOKEN);
      log.info({ registered }, "slash commands registered");
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, "command registration failed; continuing");
    }
  }

  // Scheduler
  const scheduler = new Scheduler(db, {
    workerId: `worker-${process.pid}-${Date.now().toString(36)}`,
    pollIntervalMs: 5_000,
    batchSize: 8,
    maxConcurrent: 4,
  });
  registerJobHandlers({ scheduler, delivery, collector, infra });
  for (const [jobType, payload] of Object.entries(recurringIntervals())) {
    await scheduler.ensureRecurring(jobType, Number((payload as { intervalSeconds: number }).intervalSeconds), payload);
  }
  scheduler.start();

  // HTTP API
  const app = buildApiServer({
    db: () => db,
    infra,
  });

  // Admin sync runs one source end to end (fetch -> dedupe -> instant
  // fanout), exactly like the hourly scheduler, so manually created
  // listings never strand in the catalog without delivery.
  registerSyncHandler(app, async (sourceId: string) => {
    const rows = await db.execute(
      sql`select id, kind, config, enabled from opportunity_sources where id = ${sourceId}`,
    );
    const row = (rows as unknown as {
      rows: Array<{ id: string; kind: string; config: Record<string, unknown> | null; enabled: number }>;
    }).rows[0];
    if (!row) return { error: "unknown source" };
    if (!row.enabled) return { error: "source disabled" };
    if (!(await claimSourceRun(db, sourceId))) {
      return { sourceId, skipped: "source ran within the last minute; retry shortly" };
    }
    return runConnectorAndFanout(db, delivery, collector, { id: row.id, kind: row.kind, config: row.config });
  });

  const server = app.listen(config.PORT, () => {
    log.info({ port: config.PORT }, "http surface listening");
  });

  gauge("orbit_boot_epoch", Date.now());

  async function stop(): Promise<void> {
    log.info("shutting down");
    await scheduler.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bot.client.destroy();
    await closeDb();
    await closeLogging();
  }

  process.on("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });
}

main().catch(async (err) => {
  console.error("fatal boot error:", err instanceof Error ? err.message : err);
  await closeLogging().catch(() => undefined);
  process.exit(1);
});
