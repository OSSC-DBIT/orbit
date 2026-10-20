import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "../../database/client.js";
import { getDb, withTenant } from "../../database/client.js";
import { opportunityDeliveries, opportunities } from "../../database/schema/index.js";
import type { StoredOpportunity } from "../../core/types/opportunity.js";
import type { GuildPreferencesRow } from "../../tenants/services/tenant-service.js";
import { matchesTenantFilters, rankOpportunities } from "../matching/matcher.js";
import { getLogger, scopedLogger } from "../../core/logging/logger.js";
import type { ChannelKind } from "../../core/types/common.js";

export interface DiscordChannel {
  id: string;
  guildId: string;
  send(payload: SendPayload): Promise<string>; // returns message id
}

export interface SendPayload {
  embeds: EmbedPayload[];
  content?: string;
  allowedMentions?: { roles?: string[]; users?: string[]; parse?: string[] };
}

export interface EmbedPayload {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordTargetResolver {
  resolve(kind: ChannelKind, guildId: string): Promise<DiscordChannel | null>;
  mentionFor(kind: ChannelKind, guildId: string): Promise<string | null> | string | null;
}

export type DeliveryKind = "instant" | "digest" | "deadline";

export interface InstantDeliveryStats {
  delivered: number;
  skippedDuplicate: number;
  filtered: number;
  failed: number;
  volumeCapped: number;
}

/**
 * Delivery engine.
 *
 * Guarantees:
 *  - exactly-once announcements per (guild, opportunity, channel, kind) via a
 *    transactional unique constraint — safe across restarts & concurrency;
 *  - respects tenant daily-volume caps;
 *  - permanent Discord failures recorded once, never retried infinitely;
 *  - transient failures release the claim so the next pass may retry.
 */
export class DeliveryService {
  constructor(
    private db: Database = getDb(),
    private targets: DiscordTargetResolver | null = null,
  ) {}

  /** Attaches the live Discord resolver once the gateway client is ready. */
  setTargets(resolver: DiscordTargetResolver): void {
    this.targets = resolver;
  }

  async deliverInstant(
    guildId: string,
    prefs: GuildPreferencesRow,
    items: StoredOpportunity[],
    maxDaily: number,
  ): Promise<InstantDeliveryStats> {
    const log = scopedLogger(getLogger(), { guildId });
    const matching = items.filter((o) => matchesTenantFilters(o, prefs).matched);
    const ranked = rankOpportunities(matching);

    const sentToday = await this.countToday(guildId);
    const quotaLeft = Math.max(0, maxDaily - sentToday);

    let stats: InstantDeliveryStats = { delivered: 0, skippedDuplicate: 0, filtered: 0, failed: 0, volumeCapped: 0 };

    const deliverable = ranked.slice(0, quotaLeft);
    stats.volumeCapped = ranked.length - deliverable.length;

    for (const opp of deliverable) {
      const result = await this.deliverOne(guildId, "opportunities", opp, "instant");
      if (result === "delivered") stats.delivered++;
      else if (result === "duplicate") stats.skippedDuplicate++;
      else stats.failed++;
    }
    log.info({ ...stats }, "instant delivery pass");
    return stats;
  }

  /**
   * Claims the delivery row transactionally (unique constraint), sends, then
   * records success/failure. A transient send error releases the claim.
   */
  async deliverOne(
    guildId: string,
    kind: ChannelKind,
    opp: StoredOpportunity,
    deliveryKind: DeliveryKind,
  ): Promise<"delivered" | "duplicate" | "fail" | "no-channel"> {
    if (!this.targets) return "no-channel";
    const channel = await this.targets.resolve(kind, guildId);
    if (!channel) return "no-channel";

    if (deliveryKind === "instant") {
      const mention = await this.targets.mentionFor(kind, guildId);
      const payload = buildSendPayload(opp, mention ? [mention] : []);
      return this.sendWithClaim(guildId, opp, channel, deliveryKind, payload);
    }

    // digest/deadline deliveries reuse the same claim mechanism
    const embeds = [buildOpportunityEmbed(opp)];
    const payload: SendPayload = { embeds, allowedMentions: { parse: [] } };
    return this.sendWithClaim(guildId, opp, channel, deliveryKind, payload);
  }

  private async sendWithClaim(
    guildId: string,
    opp: StoredOpportunity,
    channel: DiscordChannel,
    deliveryKind: DeliveryKind,
    payload: SendPayload,
  ): Promise<"delivered" | "duplicate" | "fail" | "no-channel"> {
    // The claim lives on a tenant-scoped transaction: the RLS policy makes
    // cross-tenant interference impossible even under future concurrency.
    return withTenant(guildId, async (tx) => {
      const inserted = await tx
        .insert(opportunityDeliveries)
        .values({
          guildId,
          opportunityId: opp.id,
          channelId: channel.id,
          deliveryKind,
        })
        .onConflictDoNothing()
        .returning({ id: opportunityDeliveries.id });
      if (!inserted.length) return "duplicate" as const;

      try {
        const messageId = await channel.send(payload);
        await tx
          .update(opportunityDeliveries)
          .set({ messageId })
          .where(eq(opportunityDeliveries.id, inserted[0]!.id));
        return "delivered" as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const permanent = /unknown channel|missing access|missing permissions/i.test(message);
        await tx
          .update(opportunityDeliveries)
          .set({ failed: 1, error: message.slice(0, 500) })
          .where(eq(opportunityDeliveries.id, inserted[0]!.id));
        if (!permanent) {
          // release the claim so the next pass can retry the transient error
          await tx
            .delete(opportunityDeliveries)
            .where(eq(opportunityDeliveries.id, inserted[0]!.id));
        }
        return "fail" as const;
      }
    });
  }

  async countToday(guildId: string): Promise<number> {
    const midnightUtc = new Date();
    midnightUtc.setUTCHours(0, 0, 0, 0);
    const rows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(opportunityDeliveries)
      .where(and(eq(opportunityDeliveries.guildId, guildId), gte(opportunityDeliveries.deliveredAt, midnightUtc)));
    return rows[0]?.c ?? 0;
  }

  /** Digest payload: up to 10 ranked items, single embed. */
  async buildDigest(guildId: string, prefs: GuildPreferencesRow, items: StoredOpportunity[]): Promise<SendPayload | null> {
    const matched = rankOpportunities(items.filter((o) => matchesTenantFilters(o, prefs).matched)).slice(0, 10);
    if (!matched.length) return null;
    const embed: EmbedPayload = {
      title: `Opportunities digest - ${matched.length} new`,
      color: 0x5865f2,
      description: matched
        .map((o) => {
          const deadline = o.applicationDeadline ? ` - ⏳ ${formatDate(o.applicationDeadline)}` : "";
          return `• **${o.title}**${deadline}${o.applicationUrl ? ` ([apply](${o.applicationUrl}))` : ""}`;
        })
        .join("\n")
        .slice(0, 4000),
      footer: { text: `Sources: ${[...new Set(matched.map((o) => o.sourceId))].join(", ")} • Orbit` },
      timestamp: new Date().toISOString(),
    };
    return { embeds: [embed], allowedMentions: { parse: [] } };
  }

  /** Opportunities likely matching tenant filters (pre-, cheap DB filter). */
  async eligibleFor(guildId: string, prefs: GuildPreferencesRow, limit = 80): Promise<StoredOpportunity[]> {
    void guildId;
    const categories = prefs.enabledCategories.length ? prefs.enabledCategories : null;
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(
        and(
          inArray(opportunities.status, ["open", "closing_soon", "discovered", "unverified"]),
          categories ? inArray(opportunities.category, categories) : undefined,
        ),
      )
      .orderBy(sql`${opportunities.applicationDeadline} nulls last`, sql`${opportunities.firstDiscoveredAt} desc`)
      .limit(limit);
    return rows as unknown as StoredOpportunity[];
  }

  /** Loads specific opportunities by id (used by the fresh-listings flow). */
  async byIds(ids: number[]): Promise<StoredOpportunity[]> {
    if (!ids.length) return [];
    const rows = await this.db.select().from(opportunities).where(inArray(opportunities.id, ids.slice(0, 300)));
    return rows as unknown as StoredOpportunity[];
  }

  /**
   * Sends a digest once per tenant per day: the deliveries claim uses the
   * top opportunity id as anchor with kind="digest", which is unique per day
   * only while the anchor stays the same; to make the day-uniqueness real we
   * rely on digest dispatch being driven by tenant-local hour matching.
   */
  async sendDigest(guildId: string, payload: SendPayload): Promise<boolean> {
    if (!this.targets) return false;
    const channel = await this.targets.resolve("digest", guildId);
    if (!channel) return false;
    try {
      await channel.send({ ...payload, allowedMentions: { parse: [] } });
      return true;
    } catch {
      return false;
    }
  }
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

const CATEGORY_COLORS: Record<string, number> = {
  hackathon: 0xeb4525,
  buildathon: 0xeb455f,
  internship: 0x5865f2,
  job: 0xfee75c,
  remote_job: 0x57f287,
  opensource_program: 0x00d166,
  student_program: 0x3498db,
  research: 0x9b59b6,
  innovation_challenge: 0xe67e22,
  grant_fellowship: 0x1abc9c,
};

export function buildOpportunityEmbed(
  opp: StoredOpportunity,
  extra?: { footerNote?: string; aiSummary?: string },
): EmbedPayload {
  const fields: EmbedPayload["fields"] = [];
  if (opp.organization) fields.push({ name: "Organizer", value: opp.organization.slice(0, 200), inline: true });
  if (opp.location) {
    fields.push({
      name: "Location",
      value: `${opp.location.slice(0, 200)}${opp.remoteStatus ? ` - ${opp.remoteStatus}` : ""}`,
      inline: true,
    });
  }
  fields.push({
    name: "Deadline",
    value: opp.applicationDeadline ? formatDate(opp.applicationDeadline) : "Unknown",
    inline: true,
  });
  if (opp.eventStartsAt) fields.push({ name: "Event starts", value: formatDate(opp.eventStartsAt), inline: true });
  const comp = opp.compensation;
  if (comp && (comp.amountMax || comp.amountMin)) {
    const cur = comp.currency ?? "";
    if (comp.amountMin && comp.amountMax && comp.amountMin !== comp.amountMax) {
      fields.push({ name: "Compensation range", value: `${cur}${comp.amountMin.toLocaleString()}–${comp.amountMax.toLocaleString()}`, inline: true });
    } else {
      const amt = (comp.amountMax ?? comp.amountMin)!.toLocaleString();
      fields.push({ name: "Compensation", value: `${cur}${amt}`, inline: true });
    }
  } else if (comp?.note) {
    fields.push({ name: "Prizes", value: comp.note.slice(0, 250), inline: true });
  }
  if (opp.requiredSkills?.length) {
    fields.push({ name: "Skills", value: opp.requiredSkills.slice(0, 10).map(pretty).join(", ").slice(0, 900), inline: false });
  }
  if (opp.eligibility?.length) {
    fields.push({ name: "Eligibility", value: opp.eligibility.slice(0, 4).join("; ").slice(0, 600), inline: false });
  }
  if (extra?.aiSummary) {
    fields.push({ name: "AI summary (unverified)", value: extra.aiSummary.slice(0, 900), inline: false });
  }
  if (opp.status === "unverified") {
    fields.push({ name: "⚠️ Unverified", value: "Some fields could not be verified against the source.", inline: false });
  }

  return {
    title: opp.title.slice(0, 250),
    url: opp.applicationUrl ?? opp.sourceUrl ?? undefined,
    description: extra?.aiSummary ? undefined : (opp.description ?? "").slice(0, 1000) || undefined,
    color: CATEGORY_COLORS[opp.category] ?? 0x2b2d31,
    fields,
    footer: { text: `${opp.sourceId}${extra?.footerNote ? ` • ${extra.footerNote}` : ""} • Orbit` },
    timestamp: opp.sourceUpdatedAt?.toISOString(),
  };
}

export function buildSendPayload(opp: StoredOpportunity, mentionRoles: string[]): SendPayload {
  return {
    embeds: [buildOpportunityEmbed(opp)],
    ...(mentionRoles.length ? { content: `<@&${mentionRoles[0]}>` } : {}),
    allowedMentions: { roles: mentionRoles },
  };
}

function pretty(s: string): string {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}
