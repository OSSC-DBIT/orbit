import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { safeEquals } from "../core/security/crypto.js";
import { toPrometheusText, metrics, gauge } from "../observability/metrics.js";
import { verifyWebhook, type WebhookHeaders, MAX_WEBHOOK_BYTES } from "../projects/webhooks/verify.js";
import { normalizeGithubEvent } from "../projects/webhooks/verify.js";
import type { EventPipeline } from "../projects/events/pipeline.js";
import type { Database } from "../database/client.js";
import { sql } from "drizzle-orm";
import { loadConfig } from "../core/config/env.js";
import { registerIntegrationRoutes } from "./integrations.js";
import { registerStaticPages } from "./pages.js";

/**
 * HTTP surface:
 *   /healthz  – liveness (no secrets, no private info)
 *   /readyz   – readiness incl. DB ping
 *   /metrics  – Prometheus text (restricted via ADMIN_API_TOKEN or local)
 *   /api/webhooks/github
 *   /api/admin/* – bearer-token admin API (source management, exports)
 */
export interface ApiServices {
  pipeline: EventPipeline | null;
  db: () => Database;
}

export function buildApiServer(services: ApiServices): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.raw({ type: "application/octet-stream", limit: "1mb" }));

  // ─── health ────────────────────────────────────────────────────────────────
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", app: "orbit" });
  });

  app.get("/readyz", async (_req: Request, res: Response) => {
    try {
      const db = services.db();
      const started = Date.now();
      await db.execute(sql`select 1`);
      res.status(200).json({ status: "ready", dbLatencyMs: Date.now() - started });
    } catch {
      res.status(503).json({ status: "unready" });
    }
  });

  // ─── metrics (restricted) ──────────────────────────────────────────────────
  const metricsGuard: (req: Request, res: Response, next: NextFunction) => void = (req, res, next) => {
    const token = process.env.ADMIN_API_TOKEN;
    if (!token) {
      // Without an admin token, restrict metrics to loopback callers only.
      const ip = req.ip ?? "";
      if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
      res.status(403).json({ error: "metrics restricted" });
      return;
    }
    const provided = req.headers.authorization;
    if (provided && provided.startsWith("Bearer ") && safeEquals(provided.slice(7), token)) return next();
    res.status(403).json({ error: "metrics restricted" });
  };
  app.get("/metrics", metricsGuard, (_req: Request, res: Response) => {
    res.type("text/plain; version=0.0.4").send(toPrometheusText());
  });

  // ─── github webhooks ───────────────────────────────────────────────────────
  app.post(
    "/api/webhooks/github",
    express.raw({ type: "*/*", limit: MAX_WEBHOOK_BYTES }),
    async (req: Request, res: Response) => {
      const started = Date.now();
      metrics.eventsReceived();
      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
        const headers = req.headers as unknown as WebhookHeaders;
        const config = loadConfig();
        const verification = verifyWebhook(rawBody, headers, config.GITHUB_WEBHOOK_SECRET);
        if (!verification.ok) {
          metrics.eventsProcessed(verification.code);
          // 401 for signature problems; 500 for config problems
          const httpStatus = verification.code === "missing-secret" ? 500 : 401;
          res.status(httpStatus).json({ error: verification.code });
          return;
        }
        if (!services.pipeline) {
          res.status(503).json({ error: "pipeline unavailable" });
          return;
        }
        const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
        const normalized = normalizeGithubEvent(verification.event!, verification.deliveryId!, payload);
        if (!normalized) {
          metrics.eventsProcessed("ignored");
          res.status(200).json({ status: "ignored" });
          return;
        }
        const result = await services.pipeline.process(verification.deliveryId!, normalized);
        if (result === "duplicate") {
          metrics.eventsProcessed("duplicate");
          res.status(200).json({ status: "duplicate" });
          return;
        }
        // Discord fanout is executed by the registered handler (bot layer).
        const fanout = (app as unknown as { fanoutHandlers: Array<FanoutHandler> }).fanoutHandlers;
        for (const handler of fanout) {
          await handler(result, normalized).catch((err: unknown) => {
            if (process.env.LOG_LEVEL === "debug") console.error("fanout failed", err);
          });
        }
        metrics.eventsProcessed("processed");
        res.status(200).json({ status: "ok", correlationId: result.correlationId });
      } catch (err) {
        metrics.eventsProcessed("error");
        if (process.env.LOG_LEVEL === "debug") console.error("webhook error", err);
        res.status(500).json({ error: "processing failed" });
      } finally {
        gauge("orbit_webhook_latency_ms", Date.now() - started);
      }
    },
  );

  (app as unknown as { fanoutHandlers: FanoutHandler[] }).fanoutHandlers = [];

  // ─── admin API ─────────────────────────────────────────────────────────────
  const adminGuard: (req: Request, res: Response, next: NextFunction) => void = (req, res, next) => {
    const token = process.env.ADMIN_API_TOKEN;
    if (!token) {
      res.status(503).json({ error: "admin API disabled (ADMIN_API_TOKEN not configured)" });
      return;
    }
    const provided = req.headers.authorization;
    if (provided && provided.startsWith("Bearer ") && safeEquals(provided.slice(7), token)) return next();
    res.status(401).json({ error: "unauthorized" });
  };

  const admin = express.Router();
  admin.use(adminGuard);

  admin.get("/sources", async (_req: Request, res: Response) => {
    const db = services.db();
    const rows = await db.execute(sql`
      select id, kind, enabled, interval_minutes, owner_guild_id,
             last_success_at, last_error, consecutive_failures
      from opportunity_sources
      order by id
    `);
    res.json((rows as unknown as { rows: unknown[] }).rows);
  });

  admin.post("/sources/:id/sync", async (req, res) => {
    const handler = (app as unknown as { syncHandler?: SyncOneHandler }).syncHandler;
    if (!handler) {
      res.status(503).json({ error: "sync not wired" });
      return;
    }
    const stats = await handler(req.params.id ?? "");
    res.json(stats);
  });

  admin.get("/jobs/failures", async (_req: Request, res: Response) => {
    const db = services.db();
    const rows = await db.execute(sql`
      select job_type, attempts, last_error, updated_at
      from scheduled_jobs
      where status = 'failed'
      order by updated_at desc
      limit 50
    `);
    res.json((rows as unknown as { rows: unknown[] }).rows);
  });

  app.use("/api/admin", admin);

  // ─── external integration API (health report + logs) ───────────────────────
  registerIntegrationRoutes(app, services.db());

  // public static pages: /, /privacy, /terms (issues + compliance links)
  registerStaticPages(app);

  // JSON error mapping – hides internals
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void err;
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

export type FanoutHandler = (
  output: import("../projects/events/pipeline.js").PipelineOutput,
  event: import("../projects/webhooks/verify.js").NormalizedGithubEvent,
) => Promise<void>;

export type SyncOneHandler = (sourceId: string) => Promise<unknown>;

export function registerFanout(app: Express, handler: FanoutHandler): void {
  (app as unknown as { fanoutHandlers: FanoutHandler[] }).fanoutHandlers.push(handler);
}

export function registerSyncHandler(app: Express, handler: SyncOneHandler): void {
  (app as unknown as { syncHandler?: SyncOneHandler }).syncHandler = handler;
}
