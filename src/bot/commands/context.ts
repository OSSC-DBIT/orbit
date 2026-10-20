import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageComponentInteraction,
} from "discord.js";
import type { Database } from "../../database/client.js";
import type { AppConfig } from "../../core/config/env.js";
import type { TenantService } from "../../tenants/services/tenant-service.js";
import type { DeliveryService } from "../../opportunities/delivery/delivery-service.js";
import type { Collector } from "../../opportunities/collectors/collector.js";
import type { AiEngine } from "../../ai/services/engine.js";
import type { WorkflowDiagnostics } from "../../projects/workflows/diagnostics.js";
import type { ReportService } from "../../projects/reporting/report-service.js";
import { DEFAULT_TIMEZONE, formatInTz } from "../../core/time/tz.js";
import { getLogger, scopedLogger } from "../../core/logging/logger.js";

/**
 * Bot command runtime context. Every handler receives the verified Discord
 * interaction plus service dependencies; tenancy is always derived from
 * interaction.guildId — never from user supplied text.
 */
export interface CommandDeps {
  tenant: TenantService;
  delivery: DeliveryService;
  config: AppConfig;
  db: Database;
  ai: AiEngine;
  collector: Collector;
  diagnostics: WorkflowDiagnostics | null;
  reports: ReportService | null;
}

export interface OrbitCommandContext {
  interaction: ChatInputCommandInteraction;
  deps: CommandDeps;
  guildId: string;
  userId: string;
  /** Effective tenant timezone (guild row or deployment default). */
  tz: string;
  /** Convenience formatter: renders any instant in tenant tz. */
  fmt: (d: Date | null) => string;
}

export interface OrbitCommand {
  name: string;
  definition:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  /** Admin gate via evaluateAdminAuthorization (interaction-derived facts). */
  adminOnly: boolean;
  handler: (ctx: OrbitCommandContext) => Promise<void>;
}

/** Extracts admin facts strictly from the verified interaction context. */
export function adminFacts(interaction: ChatInputCommandInteraction): {
  guildId: string | null;
  userId: string | null;
  permissionBits: string | null;
  roleIds: string[];
} {
  const permissionBits =
    interaction.memberPermissions !== null ? interaction.memberPermissions.bitfield.toString() : null;
  // Gateway interactions for guild users are GuildMember instances.
  const member = interaction.member as { roles?: { cache?: Map<string, unknown> } } | null;
  const roleIds = member?.roles?.cache ? Array.from(member.roles.cache.keys()) : [];
  return {
    guildId: interaction.guildId,
    userId: interaction.user?.id ?? null,
    permissionBits,
    roleIds,
  };
}

/** Throws ForbiddenError unless the caller manages this guild. */
export async function requireAdmin(ctx: OrbitCommandContext): Promise<void> {
  const facts = adminFacts(ctx.interaction);
  await ctx.deps.tenant.assertCanAdminister(ctx.guildId, facts.userId, facts.permissionBits, facts.roleIds);
}

export async function isAdmin(ctx: OrbitCommandContext): Promise<boolean> {
  const facts = adminFacts(ctx.interaction);
  return ctx.deps.tenant.canAdminister(ctx.guildId, facts.userId, facts.permissionBits, facts.roleIds);
}

/* ── replies ──────────────────────────────────────────────────────────────── */

const EPHEMERAL_FLAG = 64; // discord.js MessageFlags.Ephemeral bitmask

export async function replyEphemeral(ctx: OrbitCommandContext, content: string | EmbedBuilder): Promise<void> {
  const payload =
    typeof content === "string"
      ? { content, flags: EPHEMERAL_FLAG }
      : { embeds: [content], flags: EPHEMERAL_FLAG };
  await ctx.interaction.reply(payload);
}

export function errorEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(title)
    .setDescription(description.slice(0, 2000))
    .setTimestamp(new Date());
}

export function infoEmbed(title: string, description: string, color = 0x5865f2): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.slice(0, 4000)).setTimestamp(new Date());
}

/* ── pagination ──────────────────────────────────────────────────────────── */

const EMBEDS_PER_PAGE = 5;
// Collector lifetime: ends after 5 minutes of inactivity (hard cap 1 hour).
// A single message's buttons used to die after flat 3 minutes, which users
// experience as a broken/laggy Next button; idle resets on every click.
const COLLECTOR_IDLE_MS = 5 * 60_000;
const COLLECTOR_MAX_MS = 60 * 60_000;

/**
 * Sends pages of up to 5 embeds with Prev/Next buttons. The collector is
 * message-scoped and self-cleans, so restarts never strand listeners.
 */
export async function sendPaginated(ctx: OrbitCommandContext, pages: EmbedBuilder[]): Promise<void> {
  if (pages.length === 0) {
    await replyEphemeral(ctx, "Nothing found yet. New listings appear after the next source sync.");
    return;
  }

  const chunks: EmbedBuilder[][] = [];
  for (let i = 0; i < pages.length; i += EMBEDS_PER_PAGE) chunks.push(pages.slice(i, i + EMBEDS_PER_PAGE));

  let index = 0;
  const render: () => { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } = () => ({
    embeds: chunks[index]!,
    components: chunks.length > 1 ? [paginationRow(index, chunks.length)] : [],
  });

  await ctx.interaction.reply({ ...render(), flags: EPHEMERAL_FLAG });
  if (chunks.length < 2) return;

  const message = await ctx.interaction.fetchReply();
  const channel = ctx.interaction.channel;
  if (!channel || !("guild" in channel)) return;

  const collector = channel.createMessageComponentCollector({
    filter: (c: MessageComponentInteraction) => c.isButton() && c.user.id === ctx.userId && c.message.id === message.id,
    idle: COLLECTOR_IDLE_MS,
    time: COLLECTOR_MAX_MS,
  });
  const log = scopedLogger(getLogger(), { tenant: "discord" });
  collector.on("collect", async (c) => {
    if (!c.isButton()) return;
    if (c.customId === "orbit:prev") index = Math.max(0, index - 1);
    else if (c.customId === "orbit:next") index = Math.min(chunks.length - 1, index + 1);
    else return;
    const startedAt = Date.now();
    try {
      await c.update(render());
    } finally {
      log.info({ component: c.customId, page: index + 1, total: chunks.length, ms: Date.now() - startedAt }, "pagination flip");
    }
  });
  collector.on("end", () => {
    // Durability: disable the row via the message webhook while it still
    // counts (15 min window); past that fall back to the interaction edit,
    // failing silently either way instead of crashing the logger loop.
    message
      .edit({ components: [paginationRow(index, chunks.length, true)] })
      .catch(() => ctx.interaction.editReply({ components: [] }).catch(() => undefined));
  });
}

function paginationRow(
  current: number,
  total: number,
  allDisabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("orbit:prev").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(allDisabled || current === 0),
    new ButtonBuilder().setCustomId("orbit:count").setLabel(`${current + 1} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("orbit:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(allDisabled || current === total - 1),
  );
}

/* ── listing rendering ───────────────────────────────────────────────────── */

import type { StoredOpportunity } from "../../core/types/opportunity.js";
import { CATEGORY_COLORS } from "./category-colors.js";

/** Compact listing embed used by browse/search/category commands. */
export function listingEmbed(item: StoredOpportunity, tz: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(CATEGORY_COLORS[item.category] ?? 0x5865f2)
    .setTitle(truncate(item.title, 250))
    .setURL(item.applicationUrl ?? item.sourceUrl ?? null)
    .setDescription(truncate(item.description ?? "No description captured.", 350));
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Category", value: item.category, inline: true },
    { name: "Source", value: item.sourceId, inline: true },
    { name: "ID", value: String(item.id), inline: true },
  ];
  if (item.organization) fields.push({ name: "Organizer", value: truncate(item.organization, 120), inline: true });
  if (item.location) fields.push({ name: "Location", value: truncate(item.location, 120), inline: true });
  if (item.applicationDeadline) {
    fields.push({ name: "Deadline (tenant time)", value: formatInTz(item.applicationDeadline, tz), inline: true });
  }
  if (item.eventStartsAt) fields.push({ name: "Event starts", value: formatInTz(item.eventStartsAt, tz), inline: true });
  if (item.remoteStatus) fields.push({ name: "Mode", value: item.remoteStatus, inline: true });
  embed.addFields(fields);
  if (item.status === "closing_soon") embed.setFooter({ text: "Closing soon - apply fast" });
  return embed;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Effective tenant timezone: explicitly configured guild tz, else deployment default (IST-first). */
export async function resolveTenantTimezone(tenant: TenantService, guildId: string): Promise<string> {
  try {
    const guild = await tenant.getGuild(guildId);
    if (guild?.timezone && guild.timezone !== "UTC") return guild.timezone;
    return DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}
