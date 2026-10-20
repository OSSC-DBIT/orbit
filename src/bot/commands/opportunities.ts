import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { OrbitCommand } from "./context.js";
import { replyEphemeral, infoEmbed, listingEmbed, sendPaginated, type OrbitCommandContext } from "./context.js";
import { opportunities, userPreferences } from "../../database/schema/index.js";
import { type OpportunityCategory } from "../../core/types/common.js";
import { formatInTz } from "../../core/time/tz.js";

/**
 * Community-facing read commands: browse/search/category lists, detail view,
 * deadline list, personal subscriptions. All tenant-safe: listings are global
 * catalog rows, never user-controlled SQL, and no cross-tenant rows are read.
 */

const OPEN_STATUSES = ["open", "closing_soon", "discovered", "unverified"] as const;

/** Discord relative timestamp: <t:seconds:R>. */
function discordTs(d: Date | null): string {
  if (!d) return "";
  return String(Math.floor(d.getTime() / 1000));
}

export function opportunityCommands(): OrbitCommand[] {
  const commands: OrbitCommand[] = [];

  // ── browse by category commands share a query ───────────────────────────────
  const browseHandler = (category: OpportunityCategory) => async (ctx: OrbitCommandContext) => {
    const rows = await ctx.deps.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.category, category), inArray(opportunities.status, [...OPEN_STATUSES])))
      .orderBy(desc(opportunities.firstDiscoveredAt))
      .limit(30);
    const embeds = rows.map((r) => listingEmbed(asStored(r), ctx.tz));
    await sendPaginated(ctx, embeds);
  };

  commands.push({
    name: "opportunities",
    definition: new SlashCommandBuilder()
      .setName("opportunities")
      .setDescription("Browse the latest opportunities across every category")
      .addStringOption((o) =>
        o
          .setName("category")
          .setDescription("Filter by category")
          .setRequired(false)
          .addChoices(
            { name: "hackathons", value: "hackathon" },
            { name: "internships", value: "internship" },
            { name: "jobs", value: "job" },
            { name: "remote jobs", value: "remote_job" },
            { name: "open source", value: "opensource_program" },
            { name: "innovation challenges", value: "innovation_challenge" },
            { name: "student programs", value: "student_program" },
            { name: "grants & fellowships", value: "grant_fellowship" },
            { name: "research", value: "research" },
          ),
      ),
    adminOnly: false,
    handler: async (ctx) => {
      const category = ctx.interaction.options.getString("category");
      const query = ctx.deps.db
        .select()
        .from(opportunities)
        .where(
          and(
            inArray(opportunities.status, [...OPEN_STATUSES]),
            category ? eq(opportunities.category, category as OpportunityCategory) : undefined,
          ),
        )
        .orderBy(desc(opportunities.firstDiscoveredAt))
        .limit(30);
      const rows = await query;
      await sendPaginated(ctx, rows.map((r) => listingEmbed(asStored(r), ctx.tz)));
    },
  });

  const CATEGORY_COMMANDS: Array<[string, OpportunityCategory, string]> = [
    ["hackathons", "hackathon", "Browse hackathons (all sources, deduplicated)"],
    ["internships", "internship", "Browse internships"],
    ["jobs", "job", "Browse developer jobs (includes remote roles)"],
    ["opensource", "opensource_program", "Browse open source programs (GSoC, Outreachy, etc.)"],
  ];
  for (const [name, category, description] of CATEGORY_COMMANDS) {
    commands.push({
      name,
      definition: new SlashCommandBuilder().setName(name).setDescription(description),
      adminOnly: false,
      handler: browseHandler(category),
    });
  }

  // ── detail ──────────────────────────────────────────────────────────────────
  commands.push({
    name: "opportunity",
    definition: new SlashCommandBuilder()
      .setName("opportunity")
      .setDescription("Full detail for one listing by id")
      .addIntegerOption((o) => o.setName("id").setDescription("Listing id (shown in browse views)").setRequired(true)),
    adminOnly: false,
    handler: async (ctx) => {
      const id = ctx.interaction.options.getInteger("id", true);
      const rows = await ctx.deps.db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
      const row = rows[0];
      if (!row) {
        await replyEphemeral(ctx, infoEmbed("Not found", `No listing #${id}. The catalog rotates listings deduplicated across restarts.`, 0xed4245));
        return;
      }
      const stored = asStored(row);
      const embed = listingEmbed(stored, ctx.tz);
      const fields: EmbedBuilder["data"]["fields"] = [];
      if (stored.eventEndsAt) fields.push({ name: "Event ends", value: formatInTz(stored.eventEndsAt, ctx.tz), inline: true });
      if (stored.requiredSkills?.length) fields.push({ name: "Skills", value: stored.requiredSkills.join(", ").slice(0, 1000), inline: false });
      if (fields?.length) embed.addFields(fields.filter((f): f is { name: string; value: string; inline?: boolean } => !!f));
      if (row.dedupKey) embed.setFooter({ text: `dedup: ${row.dedupKey.slice(0, 60)}` });
      await replyEphemeral(ctx, embed);
    },
  });

  // ── search ──────────────────────────────────────────────────────────────────
  commands.push({
    name: "search",
    definition: new SlashCommandBuilder()
      .setName("search")
      .setDescription("Search listings by keyword")
      .addStringOption((o) => o.setName("query").setDescription("Search text (title, description, tags)").setRequired(true))
      .addStringOption((o) => o.setName("category").setDescription("Optional category filter").setRequired(false).addChoices(
        { name: "hackathons", value: "hackathon" },
        { name: "internships", value: "internship" },
        { name: "jobs", value: "job" },
        { name: "remote jobs", value: "remote_job" },
        { name: "open source", value: "opensource_program" },
      )),
    adminOnly: false,
    handler: async (ctx) => {
      const q = ctx.interaction.options.getString("query", true).trim().slice(0, 80);
      const category = ctx.interaction.options.getString("category");
      const pattern = `%${q}%`;
      const rows = await ctx.deps.db
        .select()
        .from(opportunities)
        .where(
          and(
            inArray(opportunities.status, [...OPEN_STATUSES]),
            category ? eq(opportunities.category, category as OpportunityCategory) : undefined,
            or(ilike(opportunities.title, pattern), ilike(sql`coalesce(${opportunities.description}, '')`, pattern)),
          ),
        )
        .orderBy(desc(opportunities.firstDiscoveredAt))
        .limit(30);
      await sendPaginated(ctx, rows.map((r) => listingEmbed(asStored(r), ctx.tz)));
    },
  });

  // ── deadlines ───────────────────────────────────────────────────────────────
  commands.push({
    name: "deadline",
    definition: new SlashCommandBuilder()
      .setName("deadline")
      .setDescription("Upcoming application deadlines (tenant timezone)")
      .addIntegerOption((o) => o.setName("days").setDescription("Only within N days (default 14)").setRequired(false)),
    adminOnly: false,
    handler: async (ctx) => {
      const days = Math.min(Math.max(ctx.interaction.options.getInteger("days") ?? 14, 1), 60);
      const cutoff = new Date(Date.now() + days * 24 * 3600 * 1000);
      const rows = await ctx.deps.db
        .select()
        .from(opportunities)
        .where(
          and(
            inArray(opportunities.status, [...OPEN_STATUSES]),
            sql`${opportunities.applicationDeadline} is not null and ${opportunities.applicationDeadline} <= ${cutoff.toISOString()}`,
          ),
        )
        .orderBy(opportunities.applicationDeadline)
        .limit(25);

      const lines = rows.map((r) => {
        const display = r.applicationDeadline ? formatInTz(r.applicationDeadline, ctx.tz) : "";
        return `<t:${discordTs(r.applicationDeadline)}:R> [${r.id}] **${r.title.slice(0, 90)}** ${display ? `- ${display}` : ""}${r.applicationUrl ? `\n<${r.applicationUrl}>` : ""}`;
      });
      await replyEphemeral(ctx, infoEmbed(`Deadlines within ${days} day(s)`, lines.join("\n") || "Nothing closing in that window.", 0xfaa61a));
    },
  });

  // ── personal subscription ───────────────────────────────────────────────────
  const upsertSubscription = async (ctx: OrbitCommandContext, subscribe: boolean): Promise<void> => {
    const values = { discordUserId: ctx.userId, personalSubscribed: subscribe ? 1 : 0 };
    await ctx.deps.db
      .insert(userPreferences)
      .values(values)
      .onConflictDoUpdate({ target: userPreferences.discordUserId, set: { personalSubscribed: subscribe ? 1 : 0 } });
    await replyEphemeral(
      ctx,
      infoEmbed(subscribe ? "Subscribed" : "Unsubscribed", subscribe ? "Guild deadline reminders may ping you." : "You will not be pinged by deadline reminders."),
    );
  };

  commands.push({
    name: "subscribe",
    definition: new SlashCommandBuilder()
      .setName("subscribe")
      .setDescription("Get pinged when deadline reminders fire in this server")
      .addStringOption((o) =>
        o
          .setName("interests")
          .setDescription("Optional comma separated interests kept with your preference row")
          .setRequired(false),
      ),
    adminOnly: false,
    handler: async (ctx) => {
      const interests = (ctx.interaction.options.getString("interests") ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10);
      await ctx.deps.db
        .insert(userPreferences)
        .values({ discordUserId: ctx.userId, personalSubscribed: 1, interests })
        .onConflictDoUpdate({ target: userPreferences.discordUserId, set: { personalSubscribed: 1 } });
      await replyEphemeral(ctx, infoEmbed("Subscribed", "You may be pinged in guild deadline reminders" + (interests.length ? ` (interests: ${interests.join(", ")})` : "") + "."));
    },
  });

  commands.push({
    name: "unsubscribe",
    definition: new SlashCommandBuilder()
      .setName("unsubscribe")
      .setDescription("Stop deadline reminder pings for yourself"),
    adminOnly: false,
    handler: async (ctx) => upsertSubscription(ctx, false),
  });

  return commands;
}

/** Row → StoredOpportunity mapping (dates from drizzle arrive as Date). */
function asStored(row: typeof opportunities.$inferSelect): import("../../core/types/opportunity.js").StoredOpportunity {
  return {
    id: row.id,
    dedupKey: row.dedupKey,
    sourceId: row.sourceId,
    externalId: row.externalId,
    title: row.title,
    organization: row.organization,
    category: row.category as OpportunityCategory,
    description: row.description,
    descriptionHtml: row.descriptionHtml,
    applicationUrl: row.applicationUrl,
    sourceUrl: row.sourceUrl,
    location: row.location,
    remoteStatus: row.remoteStatus,
    compensation: row.compensation ?? null,
    requiredSkills: (row.requiredSkills ?? []) as string[],
    eligibility: row.eligibility ?? null,
    opensAt: row.opensAt,
    applicationDeadline: row.applicationDeadline,
    eventStartsAt: row.eventStartsAt,
    eventEndsAt: row.eventEndsAt,
    status: row.status as import("../../core/types/common.js").OpportunityStatus,
    closingSoonAt: row.closingSoonAt,
    firstDiscoveredAt: row.firstDiscoveredAt,
    lastSeenAt: row.lastSeenAt,
    lastVerifiedAt: row.lastVerifiedAt,
    sourcePublishedAt: row.sourcePublishedAt,
    sourceUpdatedAt: row.sourceUpdatedAt,
    contentFingerprint: row.contentFingerprint,
    aiSummary: row.aiSummary,
    confidence: row.confidence,
    metadata: row.metadata ?? {},
  };
}
