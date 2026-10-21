import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../database/client.js";
import { withTenant } from "../database/client.js";
import { infraEvents, infrastructureHosts } from "../database/schema/index.js";
import { getLogger, scopedLogger } from "../core/logging/logger.js";

/**
 * Project status monitoring (push API): external projects (the user's other
 * services, scripts, deployments) periodically push heartbeats and events
 * with a per-project bearer enrol token. Orbit stores every event tenant
 * scoped and posts it into the project's Discord channel; a watchdog sweep
 * flags projects that stop heartbeating.
 *
 * Guarantees:
 * - the enrol token itself is never stored, only its sha256 hex;
 * - pushes are tenant scoped (guild bound rows, RLS enforced);
 * - announcing is fail open: a Discord failure never loses the event row;
 * - message text is rendered as plain text; no markdown link rendering of
 *   unverified URLs.
 */

export type InfraSeverity = "ok" | "info" | "warn" | "error";

export interface InfraHostRow {
  id: number;
  guildId: string;
  name: string;
  homeUrl: string | null;
  notifyChannelId: string | null;
  slaMinutes: number;
  status: string;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
}

export interface InfraEventInput {
  severity?: unknown;
  message: string;
  meta?: Record<string, unknown>;
}

/** Canonical severities; anything unknown degrades to "info" rather than throwing. */
export function resolveSeverity(value: unknown): InfraSeverity {
  return value === "ok" || value === "warn" || value === "error" ? value : "info";
}

/** sha256 hex of the enrol token: the only representation persisted. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Watchdog rule: a host is stale when it has been silent longer than its
 * slaMinutes budget. Never heartbeated hosts count from creation.
 */
export function isHostStale(
  host: Pick<InfraHostRow, "status" | "lastHeartbeatAt" | "createdAt" | "slaMinutes">,
  now = new Date(),
): boolean {
  if (host.status === "stale") return false;
  const reference = host.lastHeartbeatAt ?? host.createdAt;
  return now.getTime() - reference.getTime() > host.slaMinutes * 60_000;
}

/** Embed palette: green ok, blurple info, yellow warn, red error. */
export function severityColor(severity: InfraSeverity): number {
  switch (severity) {
    case "ok":
      return 0x57f287;
    case "warn":
      return 0xfee75c;
    case "error":
      return 0xed4245;
    default:
      return 0x5865f2;
  }
}

export interface AnnounceInput {
  host: InfraHostRow;
  severity: InfraSeverity;
  message: string;
  occurredAt: Date;
  eventId: number;
}

/**
 * Announcer built by the boot layer (bot side): resolves the project's
 * channel and posts the embed. Returns the channel id when posted, null when
 * there is no target (the event stays stored, unannounced).
 */
export type AnnounceFn = (input: AnnounceInput) => Promise<string | null>;

export class InfraService {
  private announceFn: AnnounceFn | null = null;

  constructor(private db: Database) {}

  setAnnouncer(fn: AnnounceFn): void {
    this.announceFn = fn;
  }

  /**
   * Records an activity heartbeat and flips a stale project back to active.
   * A recovery is also announced into the project channel without spamming:
   * one green event per stale period.
   */
  async ingestHeartbeat(host: InfraHostRow): Promise<{ recovered: boolean; announced: boolean }> {
    const recovered = host.status === "stale";
    const now = new Date();
    let recoveryEventId = 0;
    await withTenant(host.guildId, async (tx) => {
      await tx
        .update(infrastructureHosts)
        .set({ lastHeartbeatAt: now, status: "active" })
        .where(eq(infrastructureHosts.id, host.id));
      if (recovered) {
        const rows = await tx
          .insert(infraEvents)
          .values({
            guildId: host.guildId,
            hostId: host.id,
            severity: "ok",
            message: `${host.name} is back online (heartbeat received after a stale period).`,
          })
          .returning({ id: infraEvents.id });
        const inserted = rows[0];
        if (inserted) recoveryEventId = inserted.id;
      }
    });
    let announced = false;
    if (recovered && recoveryEventId > 0) {
      announced = await this.announce(
        { ...host, status: "active", lastHeartbeatAt: now },
        {
          severity: "ok",
          message: `${host.name} is back online (heartbeat received after a stale period).`,
          occurredAt: now,
          eventId: recoveryEventId,
        },
      );
    }
    return { recovered, announced };
  }

  /** Stores a pushed event; Discord announce failures never lose the row. */
  async ingestEvent(
    host: InfraHostRow,
    input: InfraEventInput,
  ): Promise<{ eventId: number; severity: InfraSeverity; announced: boolean }> {
    const severity = resolveSeverity(input.severity);
    const message = String(input.message ?? "").trim().slice(0, 1000);
    if (!message) throw new Error("message required");
    const meta =
      input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
        ? (input.meta as Record<string, unknown>)
        : {};

    const eventId = await withTenant(host.guildId, async (tx) => {
      const rows = await tx
        .insert(infraEvents)
        .values({ guildId: host.guildId, hostId: host.id, severity, message, meta })
        .returning({ id: infraEvents.id });
      const inserted = rows[0];
      if (!inserted) throw new Error("infra event insert returned no row");
      return inserted.id;
    });

    const announced = await this.announce(host, { severity, message, occurredAt: new Date(), eventId });
    return { eventId, severity, announced };
  }

  /**
   * Watchdog: flags every silent project stale, records the detection as an
   * error event and posts it. Idempotent per stale period: a stale project
   * stops matching until the next heartbeat returns it to active.
   */
  async sweepStaleHosts(): Promise<number> {
    const rows = (
      await this.db.execute(
        // system scope read on purpose: the watchdog runs for every tenant;
        // each row carries its guild_id and every write below re-scopes to it.
        sql`select id, guild_id, name, notify_channel_id, sla_minutes, status, last_heartbeat_at, created_at
              from infrastructure_hosts
             where status in ('active','pending')
               and guild_id in (select guild_id from discord_guilds where left_at is null)`,
      )
    ) as unknown as { rows: Array<Record<string, unknown>> };
    if (rows.rows.length === 0) return 0;

    const now = new Date();
    let flagged = 0;
    for (const row of rows.rows) {
      const host: InfraHostRow = {
        id: Number(row.id),
        guildId: String(row.guild_id),
        name: String(row.name),
        homeUrl: null,
        notifyChannelId: (row.notify_channel_id as string | null) ?? null,
        slaMinutes: Number(row.sla_minutes ?? 60),
        status: String(row.status),
        lastHeartbeatAt: row.last_heartbeat_at ? new Date(String(row.last_heartbeat_at)) : null,
        createdAt: new Date(String(row.created_at)),
      };
      if (!isHostStale(host, now)) continue;
      flagged += 1;
      const message = `${host.name} stale: no heartbeat for over ${host.slaMinutes} min (last seen ${
        host.lastHeartbeatAt ? host.lastHeartbeatAt.toISOString() : "never"
      }).`;
      await withTenant(host.guildId, async (tx) => {
        await tx.update(infrastructureHosts).set({ status: "stale" }).where(eq(infrastructureHosts.id, host.id));
        const inserted = await tx
          .insert(infraEvents)
          .values({ guildId: host.guildId, hostId: host.id, severity: "error", message })
          .returning({ id: infraEvents.id });
        const eventRow = inserted[0];
        if (eventRow) {
          await this.announce({ ...host, status: "stale" }, {
            severity: "error",
            message,
            occurredAt: now,
            eventId: eventRow.id,
          });
        }
      });
    }
    return flagged;
  }

  /** Best effort Discord fanout; failures leave the event stored unannounced. */
  private async announce(host: InfraHostRow, input: Omit<AnnounceInput, "host">): Promise<boolean> {
    const fn = this.announceFn;
    if (!fn) return false;
    try {
      const channelId = await fn({ host, ...input });
      if (!channelId) return false;
      if (input.eventId > 0) {
        await withTenant(host.guildId, async (tx) => {
          await tx
            .update(infraEvents)
            .set({ announcedAt: new Date(), announcedChannelId: channelId })
            .where(eq(infraEvents.id, input.eventId));
        });
      }
      return true;
    } catch (err) {
      scopedLogger(getLogger(), { feature: "monitoring" }).warn(
        { hostId: host.id, error: err instanceof Error ? err.message : String(err) },
        "infra announce failed",
      );
      return false;
    }
  }
}
