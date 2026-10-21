import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { safeEquals } from "../core/security/crypto.js";
import { tokenHash } from "../monitoring/infra.js";
import type { Database } from "../database/client.js";
import type { InfraHostRow, InfraService } from "../monitoring/infra.js";

/**
 * Project monitoring ingest: POST events and heartbeats for a registered
 * project, authenticated with that project's bearer enrol token. Tokens are
 * compared hashed; nothing about the request is trusted beyond a small,
 * clamped payload (plain text message, optional meta object).
 */

const MAX_MESSAGE_LENGTH = 1000;
const MAX_META_BYTES = 1500;
const RATE_BUCKET_MS = 60_000;
const RATE_BUCKET_CAP = 30;

export function registerProjectRoutes(app: Express, infra: InfraService | null, db: Database): void {
  /** Fixed 1 minute window buckets, keyed by project id. */
  const buckets = new Map<number, { count: number; resetAt: number }>();

  function allow(hostId: number): boolean {
    const now = Date.now();
    if (buckets.size > 4096) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    }
    const bucket = buckets.get(hostId);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(hostId, { count: 1, resetAt: now + RATE_BUCKET_MS });
      return true;
    }
    if (bucket.count >= RATE_BUCKET_CAP) return false;
    bucket.count += 1;
    return true;
  }

  const guard: (req: Request, res: Response, next: NextFunction) => Promise<void> = async (req, res, next) => {
    try {
      if (!infra) {
        res.status(503).json({ error: "project monitoring not available" });
        return;
      }
      const id = /^(\d+)$/.exec(String(req.params.id ?? ""));
      if (!id) {
        res.status(404).json({ error: "unknown project" });
        return;
      }
      const hostId = Number(id[1]);
      if (!allow(hostId)) {
        res.status(429).json({ error: "rate limited", retrySeconds: 60 });
        return;
      }
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) {
        res.status(401).json({ error: "missing enrol token" });
        return;
      }
      const hashRows = (
        await db.execute(sql`select enrol_token_hash from infrastructure_hosts where id = ${hostId}`)
      ) as unknown as { rows: Array<{ enrol_token_hash: string }> };
      const hash = hashRows.rows[0]?.enrol_token_hash;
      if (!hash || !safeEquals(tokenHash(token), hash)) {
        res.status(401).json({ error: "invalid enrol token" });
        return;
      }
      const hostRows = (
        await db.execute(
          sql`select id, guild_id, name, home_url, notify_channel_id, sla_minutes, status, last_heartbeat_at, created_at
                from infrastructure_hosts where id = ${hostId}`,
        )
      ) as unknown as { rows: Array<Record<string, unknown>> };
      const row = hostRows.rows[0];
      if (!row) {
        res.status(404).json({ error: "unknown project" });
        return;
      }
      res.locals.infraHost = toHostRow(row);
      next();
    } catch {
      res.status(500).json({ error: "internal error" });
    }
  };

  app.post("/api/projects/:id/events", guard, async (req: Request, res: Response) => {
    if (!infra) {
      res.status(503).json({ error: "project monitoring not available" });
      return;
    }
    const host = res.locals.infraHost as InfraHostRow;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (typeof body.meta !== "undefined" && (body.meta === null || typeof body.meta !== "object" || Array.isArray(body.meta))) {
      res.status(400).json({ error: "meta must be an object" });
      return;
    }
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    if (meta && JSON.stringify(meta).length > MAX_META_BYTES) {
      res.status(400).json({ error: "meta too large" });
      return;
    }
    const result = await infra.ingestEvent(host, { severity: body.severity, message: message.slice(0, MAX_MESSAGE_LENGTH), meta });
    res.status(202).json({ status: "stored", eventId: result.eventId, announced: result.announced });
  });

  app.post("/api/projects/:id/heartbeat", guard, async (_req: Request, res: Response) => {
    if (!infra) {
      res.status(503).json({ error: "project monitoring not available" });
      return;
    }
    const host = res.locals.infraHost as InfraHostRow;
    const result = await infra.ingestHeartbeat(host);
    res.status(202).json({ status: "ok", recovered: result.recovered, announced: result.announced });
  });
}

/** Parse a raw DB row into the monitor-facing host shape (no token hash included). */
function toHostRow(row: Record<string, unknown>): InfraHostRow {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    name: String(row.name),
    homeUrl: (row.home_url as string | null) ?? null,
    notifyChannelId: (row.notify_channel_id as string | null) ?? null,
    slaMinutes: Number(row.sla_minutes ?? 60),
    status: String(row.status),
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(String(row.last_heartbeat_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}
