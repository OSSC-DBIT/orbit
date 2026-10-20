import type { Database } from "../../database/client.js";
import { getDb } from "../../database/client.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { deadlineNotifications, opportunities } from "../../database/schema/index.js";
import type { GuildPreferencesRow } from "../../tenants/services/tenant-service.js";
import type { StoredOpportunity } from "../../core/types/opportunity.js";
import { getLogger, scopedLogger } from "../../core/logging/logger.js";

/**
 * Deadline notification scheduler.
 *
 * For every tenant-preference set and every matching open opportunity with a
 * deadline, materializes `deadline_notifications` rows for each configured
 * offset, uniquely constrained per (guild, opportunity, offset). A sweep job
 * sends those due, then marks `sent_at`. Timezone affects presentation only —
 * communications compare UTC instants.
 */
export class DeadlineScheduler {
  constructor(private db: Database = getDb()) {}

  /** Reconciles upcoming notifications for all current tenant matching opens. */
  async materializeForTenant(tenant: GuildPreferencesRow, items: StoredOpportunity[]): Promise<number> {
    let created = 0;
    const now = new Date();
    for (const opp of items) {
      if (!opp.applicationDeadline) continue;
      if (opp.applicationDeadline.getTime() <= now.getTime()) continue;
      for (const offsetMinutes of tenant.reminderOffsets) {
        const scheduledFor = new Date(opp.applicationDeadline.getTime() - offsetMinutes * 60 * 1000);
        if (scheduledFor <= now) continue; // too late to remind
        const inserted = await this.db
          .insert(deadlineNotifications)
          .values({
            guildId: tenant.guildId,
            opportunityId: opp.id,
            offsetMinutes,
            scheduledFor,
          })
          .onConflictDoNothing()
          .returning({ id: deadlineNotifications.id });
        created += inserted.length ? 1 : 0;
      }
    }
    return created;
  }

  /** Sends all due notifications (idempotent via sent_at null-check + claim). */
  async sendDue(
    deliver: (guildId: string, opp: StoredOpportunity, offsetMinutes: number) => Promise<"delivered" | "duplicate" | "fail" | "no-channel">,
    limit = 50,
  ): Promise<{ sent: number; failed: number }> {
    const log = scopedLogger(getLogger(), { tenant: "deadline-sweep" });
    const now = new Date();
    let sent = 0;
    let failed = 0;

    const due = await this.db
      .select({
        id: deadlineNotifications.id,
        guildId: deadlineNotifications.guildId,
        opportunityId: deadlineNotifications.opportunityId,
        offsetMinutes: deadlineNotifications.offsetMinutes,
      })
      .from(deadlineNotifications)
      .where(
        and(
          isNull(deadlineNotifications.sentAt),
          eq(deadlineNotifications.failed, 0),
          sql`${deadlineNotifications.scheduledFor} <= ${now.toISOString()}`,
        ),
      )
      .limit(limit);

    for (const row of due) {
      const oppRows = await this.db
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, row.opportunityId))
        .limit(1);
      const opp = oppRows[0] as StoredOpportunity | undefined;
      if (!opp || !["open", "closing_soon"].includes(opp.status)) {
        await this.db
          .update(deadlineNotifications)
          .set({ sentAt: now, failed: 0 })
          .where(eq(deadlineNotifications.id, row.id));
        continue;
      }
      const result = await deliver(row.guildId, opp, row.offsetMinutes);
      if (result === "delivered" || result === "duplicate") {
        await this.db
          .update(deadlineNotifications)
          .set({ sentAt: now })
          .where(eq(deadlineNotifications.id, row.id));
        sent++;
      } else {
        await this.db
          .update(deadlineNotifications)
          .set({ failed: 1 })
          .where(eq(deadlineNotifications.id, row.id));
        failed++;
        log.warn({ deadlineId: row.id, opportunityId: row.opportunityId, result }, "deadline delivery failed");
      }
    }

    return { sent, failed };
  }
}
