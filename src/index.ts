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
import { Collector } from "./opportunities/collectors/collector.js";
import { ensureDefaultSources } from "./opportunities/connectors/registry.js";
import { createConnector } from "./opportunities/connectors/index.js";
import { AiEngine } from "./ai/services/engine.js";
import { Scheduler } from "./jobs/scheduler.js";
import { registerJobHandlers, recurringIntervals } from "./jobs/handlers.js";
import { buildApiServer, registerFanout, registerSyncHandler } from "./api/server.js";
import { EventPipeline } from "./projects/events/pipeline.js";
import { ReportService } from "./projects/reporting/report-service.js";
import { WorkflowDiagnostics } from "./projects/workflows/diagnostics.js";
import { GitHubApi } from "./projects/github/api.js";
import { loadGitHubAppCredentials } from "./projects/github/auth.js";
import { TokenStore } from "./projects/github/token-store.js";
import { startDiscordClient, registerCommands } from "./bot/client.js";
import { DiscordTargetResolver } from "./bot/channel-resolver.js";
import type { CommandDeps } from "./bot/commands/context.js";
import { metrics, gauge } from "./observability/metrics.js";
import { buildProjectEmbed, embedToPayload } from "./bot/github-notify.js";
import type { NormalizedGithubEvent } from "./projects/webhooks/verify.js";
import type { PipelineOutput } from "./projects/events/pipeline.js";

async function main(): Promise<void> {
  const config = loadConfig(); // fails fast with actionable message
  const log = scopedLogger(getLogger(), { tenant: "boot" });
  const db = getDb();

  await ensureDefaultSources(db);

  const tenant = new TenantService(db);
  const ai = AiEngine.fromEnv();
  const collector = new Collector(db);
  const delivery = new DeliveryService(db, null); // resolver attaches post-gateway
  const pipeline = new EventPipeline(db);
  const reports = new ReportService(db);

  const credentials = loadGitHubAppCredentials(config);
  const tokenStore = credentials ? new TokenStore(db) : null;
  const gitHubApi = new GitHubApi(
    async (repoFullName) => {
      // per-repo installation mapping is learned from webhook events; guild
      // projects store the installation that delivered their first event
      const rows = await db.execute(
        sql`select installation_id from guild_projects where repository_full_name = ${repoFullName} limit 1`,
      );
      const rows0 = (rows as unknown as { rows: Array<{ installation_id: string | null }> }).rows;
      return rows0[0]?.installation_id ?? null;
    },
    async (installationId) => {
      if (!credentials || !tokenStore) return null;
      return tokenStore.tokenFor(installationId, credentials);
    },
    credentials,
  );
  const diagnostics = credentials ? new WorkflowDiagnostics(gitHubApi, ai) : null;

  const deps: CommandDeps = {
    tenant,
    delivery,
    config,
    db,
    ai,
    collector,
    diagnostics,
    reports,
  };

  // Discord gateway
  const bot = await startDiscordClient(deps, config);
  const resolver = new DiscordTargetResolver(bot.client, tenant);
  delivery.setTargets(resolver);

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
  registerJobHandlers({ scheduler, delivery, collector });
  for (const [jobType, payload] of Object.entries(recurringIntervals())) {
    await scheduler.ensureRecurring(jobType, Number((payload as { intervalSeconds: number }).intervalSeconds), payload);
  }
  scheduler.start();

  // HTTP API
  const app = buildApiServer({
    pipeline,
    db: () => db,
  });

  registerFanout(app, async (output: PipelineOutput, event: NormalizedGithubEvent) => {
    const embed = buildProjectEmbed(event, (await tenant.getGuild(output.targets[0]?.guildId ?? ""))?.timezone ?? "Asia/Kolkata");
    for (const target of output.targets) {
      const kind = target.severity === "alert" ? "github_alerts" : "github_activity";
      const channel = await resolver.resolve(kind, target.guildId);
      if (!channel) continue;
      try {
        await channel.send({ embeds: [embedToPayload(embed)], allowedMentions: { parse: [] } });
        metrics.deliveries("github", "delivered");
        await db.execute(sql`
          update project_events
          set announced_at = now()
          where guild_id = ${target.guildId} and repository_full_name = ${event.repoFullName}
            and occurred_at >= now() - interval '2 hours' and event_type = ${event.eventType}
            and announced_at is null
        `);
      } catch (err) {
        metrics.deliveries("github", "failed");
        log.warn({ guildId: target.guildId, error: err instanceof Error ? err.message : String(err) }, "github fanout failed");
      }
    }
  });

  registerSyncHandler(app, async (sourceId: string) => {
    const rows = await db.execute(
      sql`select kind, config, enabled from opportunity_sources where id = ${sourceId}`,
    );
    const row = (rows as unknown as { rows: Array<{ kind: string; config: Record<string, unknown> | null; enabled: number }> }).rows[0];
    if (!row) return { error: "unknown source" };
    if (!row.enabled) return { error: "source disabled" };
    const connector = createConnector(sourceId, row.kind, row.config ?? {});
    if (!connector) return { error: "no connector" };
    return collector.run(connector);
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
