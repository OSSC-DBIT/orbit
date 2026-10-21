import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { Database } from "../../database/client.js";
import type { AppConfig } from "../../core/config/env.js";
import type { ButtonInteraction } from "discord.js";
import type { TenantService } from "../../tenants/services/tenant-service.js";
import type { DeliveryService } from "../../opportunities/delivery/delivery-service.js";
import type { Collector } from "../../opportunities/collectors/collector.js";
import type { AiEngine } from "../../ai/services/engine.js";
import type { InfraService } from "../../monitoring/infra.js";
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
  /** Project monitoring ingest (push API) service. */
  infra: InfraService;
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

/**
 * Page registry: messageId -> page state. Button clicks are routed globally
 * from the interaction router, so there is no per-message collector to leak,
 * orphan across restarts, or let die silently. Pages rendered by a previous
 * process answer with a clear ephemeral note instead of the interaction
 * timeout toast users saw as "didn't respond in time".
 */
interface PaginationState {
  chunks: EmbedBuilder[][];
  index: number;
  owner: string;
}

const PAGE_REGISTRY = new Map<string, PaginationState>();
const PAGE_REGISTRY_MAX = 200;

function rememberPagination(messageId: string, state: PaginationState): void {
  if (PAGE_REGISTRY.size >= PAGE_REGISTRY_MAX) {
    const oldest = PAGE_REGISTRY.keys().next().value as string | undefined;
    if (oldest !== undefined) PAGE_REGISTRY.delete(oldest);
  }
  PAGE_REGISTRY.set(messageId, state);
}

/**
 * Sends pages of up to 5 embeds with Prev/Next buttons and remembers the
 * page state for the interaction router.
 */
export async function sendPaginated(ctx: OrbitCommandContext, pages: EmbedBuilder[]): Promise<void> {
  if (pages.length === 0) {
    await replyEphemeral(ctx, "Nothing found yet. New listings appear after the next source sync.");
    return;
  }

  const chunks: EmbedBuilder[][] = [];
  for (let i = 0; i < pages.length; i += EMBEDS_PER_PAGE) chunks.push(pages.slice(i, i + EMBEDS_PER_PAGE));

  await ctx.interaction.reply({
    embeds: chunks[0]!,
    components: chunks.length > 1 ? [paginationRow(0, chunks.length)] : [],
    flags: EPHEMERAL_FLAG,
  });
  if (chunks.length < 2) return; // single page: no buttons, nothing to track

  const message = await ctx.interaction.fetchReply();
  rememberPagination(message.id, { chunks, index: 0, owner: ctx.userId });
}

/**
 * Router hook for Orbit pagination buttons. Acks every click fast: known
 * messages flip in-process; unknown ones (pre restart) explain what happened
 * instead of timing out.
 */
export async function routePaginationButton(button: ButtonInteraction): Promise<void> {
  const state = PAGE_REGISTRY.get(button.message.id);
  if (!state) {
    await button
      .reply({
        content: "These pages expired with the last deployment restart. Run the command again for fresh pages.",
        flags: EPHEMERAL_FLAG,
      })
      .catch(() => undefined);
    return;
  }
  if (button.user.id !== state.owner) {
    await button
      .reply({ content: "Only the member who ran this command can page through it.", flags: EPHEMERAL_FLAG })
      .catch(() => undefined);
    return;
  }
  if (button.customId === "orbit:prev") state.index = Math.max(0, state.index - 1);
  else if (button.customId === "orbit:next") state.index = Math.min(state.chunks.length - 1, state.index + 1);
  else return;

  const startedAt = Date.now();
  try {
    await button.update({
      embeds: state.chunks[state.index]!,
      components: [paginationRow(state.index, state.chunks.length)],
    });
  } finally {
    scopedLogger(getLogger(), { tenant: "discord" }).info(
      { component: button.customId, page: state.index + 1, total: state.chunks.length, ms: Date.now() - startedAt },
      "pagination flip",
    );
  }
}

function paginationRow(current: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("orbit:prev").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId("orbit:count").setLabel(`${current + 1} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("orbit:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(current === total - 1),
  );
}

/* ── listing rendering ───────────────────────────────────────────────────── */

import type { StoredOpportunity } from "../../core/types/opportunity.js";
import { CATEGORY_COLORS } from "./category-colors.js";

/** Compact listing embed used by browse/search/category commands. */
export function listingEmbed(item: StoredOpportunity, tz: string): EmbedBuilder {
  // discord.js rejects an empty-string description outright, and the `??`
  // fallback does not catch ""; empty text must render the placeholder.
  const description = truncate(item.description?.trim() ? item.description : "No description captured.", 350);
  const embed = new EmbedBuilder()
    .setColor(CATEGORY_COLORS[item.category] ?? 0x5865f2)
    .setTitle(truncate(item.title, 250))
    .setURL(item.applicationUrl ?? item.sourceUrl ?? null)
    .setDescription(description);
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
  if (item.eventEndsAt && item.eventEndsAt.getTime() >= Date.now() && item.eventStartsAt && item.eventStartsAt.getTime() <= Date.now()) {
    // ongoing window: a past "starts" date reads like an expired opportunity,
    // so live running events surface their true state instead
    fields.push({ name: "Event running, ends", value: formatInTz(item.eventEndsAt, tz), inline: true });
  } else if (item.eventStartsAt) {
    fields.push({ name: "Event starts", value: formatInTz(item.eventStartsAt, tz), inline: true });
  }
  if (item.remoteStatus) fields.push({ name: "Mode", value: item.remoteStatus, inline: true });
  const regOpen = (item.metadata as { isRegistrationOpen?: unknown } | null)?.isRegistrationOpen;
  if (typeof regOpen === "boolean") {
    // HackCulture cards carry no registration cutoff: show the real door
    // state and say so, rather than inserting a guessed deadline
    fields.push({
      name: "Registration",
      value: regOpen ? "Open (source lists no cutoff)" : "Closed",
      inline: true,
    });
  }
  const cover = (item.metadata as { coverImage?: unknown } | null)?.coverImage;
  if (typeof cover === "string" && cover.startsWith("https://")) {
    embed.setThumbnail(cover); // per-item cover art keeps 5 card pages scannable
  }
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
