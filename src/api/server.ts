import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { safeEquals } from "../core/security/crypto.js";
import { toPrometheusText } from "../observability/metrics.js";
import type { Database } from "../database/client.js";
import { sql } from "drizzle-orm";
import type { InfraService } from "../monitoring/infra.js";
import { registerIntegrationRoutes } from "./integrations.js";
import { registerStaticPages } from "./pages.js";
import { registerProjectRoutes } from "./projects.js";

/**
 * HTTP surface:
 *   /healthz  - liveness (no secrets, no private info)
 *   /readyz   - readiness incl. DB ping
 *   /metrics  - Prometheus text (restricted via ADMIN_API_TOKEN or local)
 *   /api/admin/* - bearer-token admin API (source management, exports)
 */
export interface ApiServices {
  db: () => Database;
  /** project monitoring ingest; null until the boot layer wires it (pushes then 503). */
  infra: InfraService | null;
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

  // project monitoring ingest (bearer enrol token per project)
  registerProjectRoutes(app, services.infra, services.db());

  // JSON error mapping – hides internals
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void err;
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

export type SyncOneHandler = (sourceId: string) => Promise<unknown>;

export function registerSyncHandler(app: Express, handler: SyncOneHandler): void {
  (app as unknown as { syncHandler?: SyncOneHandler }).syncHandler = handler;
}
