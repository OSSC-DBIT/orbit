import { SlashCommandBuilder } from "discord.js";
import type { OrbitCommand } from "./context.js";
import { requireAdmin, replyEphemeral, infoEmbed } from "./context.js";
import { CHANNEL_KINDS, FEATURE_KEYS, OPPORTUNITY_CATEGORIES } from "../../core/types/common.js";
import { getSourceHealth, getOpportunityCountBySource, setSourceEnabled } from "./source-info.js";

/** Choice lists derive from the canonical arrays so new kinds cannot drift. */
const KIND_CHOICES = CHANNEL_KINDS.map((kind) => ({ name: kind, value: kind }));
const FEATURE_CHOICES = FEATURE_KEYS.map((feature) => ({ name: feature, value: feature }));

/**
 * Configuration commands (admin): /features /channels /preferences /digest
 * /sources. Every mutation is recorded through TenantService (audited).
 */

export function configCommands(): OrbitCommand[] {
  const commands: OrbitCommand[] = [];

  // ── features ────────────────────────────────────────────────────────────────
  commands.push({
    name: "features",
    definition: new SlashCommandBuilder()
      .setName("features")
      .setDescription("Enable or disable Orbit capability groups in this server")
      .addSubcommand((s) => s.setName("list").setDescription("Show feature states"))
      .addSubcommand((s) =>
        s
          .setName("enable")
          .setDescription("Enable a feature")
          .addStringOption((o) =>
            o
              .setName("kind")
              .setDescription("Which capability")
              .setRequired(true)
              .addChoices(...FEATURE_CHOICES),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("disable")
          .setDescription("Disable a feature")
          .addStringOption((o) =>
            o
              .setName("kind")
              .setDescription("Which capability")
              .setRequired(true)
              .addChoices(...FEATURE_CHOICES),
          ),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const sub = ctx.interaction.options.getSubcommand(true);
      const tenant = ctx.deps.tenant;

      if (sub === "list") {
        const map = await tenant.getFeatures(ctx.guildId);
        const lines = [...map.entries()].map(([k, v]) => `${v ? "🟢 enabled" : "⚪ disabled"} \`${k}\``);
        await replyEphemeral(ctx, infoEmbed("Feature groups", lines.join("\n")));
        return;
      }

      const feature = ctx.interaction.options.getString("kind", true) as (typeof FEATURE_KEYS)[number];
      const enable = sub === "enable";
      await tenant.setFeature(ctx.guildId, feature, enable, ctx.userId);
      await replyEphemeral(ctx, infoEmbed(`Feature ${enable ? "enabled" : "disabled"}`, `\`${feature}\` is now ${enable ? "on" : "off"} for this server.`));
    },
  });

  // ── channels ────────────────────────────────────────────────────────────────
  commands.push({
    name: "channels",
    definition: new SlashCommandBuilder()
      .setName("channels")
      .setDescription("Map Orbit feeds to channels in this server")
      .addSubcommand((s) => s.setName("list").setDescription("Current channel mapping"))
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Bind a channel kind")
          .addStringOption((o) =>
            o.setName("kind").setDescription("Which feed").setRequired(true).addChoices(...KIND_CHOICES),
          )
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(0, 5),
          )
          .addRoleOption((o) => o.setName("mention").setDescription("Optional role pinged on delivery").setRequired(false)),
      )
      .addSubcommand((s) =>
        s
          .setName("clear")
          .setDescription("Unbind a channel kind")
          .addStringOption((o) =>
            o.setName("kind").setDescription("Which feed").setRequired(true).addChoices(...KIND_CHOICES),
          ),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const tenant = ctx.deps.tenant;
      const sub = ctx.interaction.options.getSubcommand(true);
      const kind = ctx.interaction.options.getString("kind", true) as (typeof CHANNEL_KINDS)[number];

      if (sub === "list") {
        const rows = await tenant.getChannels(ctx.guildId);
        await replyEphemeral(
          ctx,
          infoEmbed("Channel mapping", rows.length ? rows.map((r) => `\`${r.kind}\` → <#${r.channelId}>${r.mentionRoleId ? ` (mention <@&${r.mentionRoleId}>)` : ""}`).join("\n") : "No channels mapped yet. Use `/channels set`.", 0xfee75c),
        );
        return;
      }

      if (sub === "set") {
        const channel = ctx.interaction.options.getChannel("channel", true);
        const mention = ctx.interaction.options.getRole("mention");
        await tenant.setChannel(ctx.guildId, kind, channel.id, ctx.userId, mention?.id ?? null);
        await replyEphemeral(ctx, infoEmbed("Channel bound", `\`${kind}\` feeds will post in <#${channel.id}>.`));
        return;
      }

      await tenant.setChannel(ctx.guildId, kind, "0", ctx.userId, null);
      await replyEphemeral(ctx, infoEmbed("Channel cleared", `\`${kind}\` is unbound.`));
    },
  });

  // ── preferences ─────────────────────────────────────────────────────────────
  commands.push({
    name: "preferences",
    definition: new SlashCommandBuilder()
      .setName("preferences")
      .setDescription("Tune which opportunities this server receives")
      .addSubcommand((s) => s.setName("view").setDescription("Show current filters"))
      .addSubcommand((s) =>
        s
          .setName("categories")
          .setDescription("Restrict opportunity categories (empty = all)")
          .addStringOption((o) => o.setName("list").setDescription("Comma separated: hackathon, internship, job, remote_job, opensource_program...").setRequired(false)),
      )
      .addSubcommand((s) =>
        s
          .setName("keywords")
          .setDescription("Include keywords (require at least one)")
          .addStringOption((o) => o.setName("list").setDescription("Comma separated keywords").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("exclude")
          .setDescription("Exclude keywords")
          .addStringOption((o) => o.setName("list").setDescription("Comma separated keywords").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("skills")
          .setDescription("Required skills filter")
          .addStringOption((o) => o.setName("list").setDescription("Comma separated skills").setRequired(false)),
      )
      .addSubcommand((s) =>
        s
          .setName("toggles")
          .setDescription("Boolean filters")
          .addBooleanOption((o) => o.setName("remote_only").setDescription("Only remote-eligible listings"))
          .addBooleanOption((o) => o.setName("paid_only").setDescription("Only paid opportunities (when known)"))
          .addBooleanOption((o) => o.setName("students_only").setDescription("Only student-eligible programs")),
      )
      .addSubcommand((s) => s.setName("reset").setDescription("Reset all preference filters")),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const tenant = ctx.deps.tenant;
      const sub = ctx.interaction.options.getSubcommand(true);

      if (sub === "view") {
        const prefs = await tenant.getPreferences(ctx.guildId);
        const embed = infoEmbed("Preference filters", [
          `categories: ${prefs.enabledCategories.length ? prefs.enabledCategories.join(", ") : "all"}`,
          `include keywords: ${prefs.includeKeywords.join(", ") || "-"}`,
          `exclude keywords: ${prefs.excludeKeywords.join(", ") || "-"}`,
          `required skills: ${prefs.requiredSkills.join(", ") || "-"}`,
          `remote only: ${prefs.remoteOnly ? "yes" : "no"} ; paid only: ${prefs.paidOnly ? "yes" : "no"} ; students: ${prefs.studentsOnly ? "yes" : "no"}`,
          `allowed sources: ${prefs.allowedSources.length ? prefs.allowedSources.join(", ") : "all"}`,
          `blocked sources: ${prefs.blockedSources.join(", ") || "-"}`,
          `min compensation: ${prefs.minCompensation ?? "-"}`,
        ].join("\n"));
        await replyEphemeral(ctx, embed);
        return;
      }

      if (sub === "reset") {
        await tenant.patchPreferences(
          ctx.guildId,
          {
            enabledCategories: [],
            includeKeywords: [],
            excludeKeywords: [],
            requiredSkills: [],
            locations: [],
            remoteOnly: false,
            paidOnly: false,
            studentsOnly: false,
            minCompensation: null,
            allowedSources: [],
            blockedSources: [],
          },
          ctx.userId,
        );
        await replyEphemeral(ctx, infoEmbed("Preferences reset", "All filters cleared: every category and source matches now."));
        return;
      }

      if (sub === "categories") {
        const raw = ctx.interaction.options.getString("list") ?? "";
        const requested = raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
        const valid = requested.filter((c): c is (typeof OPPORTUNITY_CATEGORIES)[number] =>
          (OPPORTUNITY_CATEGORIES as readonly string[]).includes(c),
        );
        const unknown = requested.filter((c) => !(OPPORTUNITY_CATEGORIES as readonly string[]).includes(c));
        await tenant.patchPreferences(ctx.guildId, { enabledCategories: valid }, ctx.userId);
        await replyEphemeral(
          ctx,
          infoEmbed(
            "Categories updated",
            `${unknown.length ? `Skipped unknown: ${unknown.join(", ")}.\n\n` : ""}Active categories: ${valid.length ? valid.join(", ") : "all (empty = every category)"}`,
          ),
        );
        return;
      }

      if (sub === "keywords") {
        const list = ctx.interaction.options.getString("list", true).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 25);
        await tenant.patchPreferences(ctx.guildId, { includeKeywords: list }, ctx.userId);
        await replyEphemeral(ctx, infoEmbed("Include keywords", list.join(", ") || "(empty, no keyword requirement)"));
        return;
      }

      if (sub === "exclude") {
        const list = ctx.interaction.options.getString("list", true).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 25);
        await tenant.patchPreferences(ctx.guildId, { excludeKeywords: list }, ctx.userId);
        await replyEphemeral(ctx, infoEmbed("Exclude keywords", list.join(", ") || "(none)"));
        return;
      }

      if (sub === "skills") {
        const list = (ctx.interaction.options.getString("list") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 25);
        await tenant.patchPreferences(ctx.guildId, { requiredSkills: list }, ctx.userId);
        await replyEphemeral(ctx, infoEmbed("Required skills updated", list.join(", ") || "(none)"));
        return;
      }

      const remoteOnly = ctx.interaction.options.getBoolean("remote_only");
      const paidOnly = ctx.interaction.options.getBoolean("paid_only");
      const studentsOnly = ctx.interaction.options.getBoolean("students_only");
      const patch: Parameters<typeof tenant.patchPreferences>[1] = {};
      if (remoteOnly !== null) patch.remoteOnly = remoteOnly;
      if (paidOnly !== null) patch.paidOnly = paidOnly;
      if (studentsOnly !== null) patch.studentsOnly = studentsOnly;
      await tenant.patchPreferences(ctx.guildId, patch, ctx.userId);
      await replyEphemeral(
        ctx,
        infoEmbed(
          "Toggles updated",
          `remote only: ${remoteOnly ?? "unchanged"} ; paid only: ${paidOnly ?? "unchanged"} ; students only: ${studentsOnly ?? "unchanged"}`,
        ),
      );
    },
  });

  // ── digest ─────────────────────────────────────────────────────────────────
  commands.push({
    name: "digest",
    definition: new SlashCommandBuilder()
      .setName("digest")
      .setDescription("Schedule the daily digest for this server")
      .addSubcommand((s) => s.setName("enable").setDescription("Turn on the daily digest"))
      .addSubcommand((s) => s.setName("disable").setDescription("Turn off the daily digest"))
      .addSubcommand((s) =>
        s
          .setName("hours")
          .setDescription("Set digest send hours in this server's local clock (0-23)")
          .addStringOption((o) => o.setName("hours").setDescription("e.g. 9,21").setRequired(true)),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const tenant = ctx.deps.tenant;
      const sub = ctx.interaction.options.getSubcommand(true);

      if (sub === "enable") {
        await tenant.setFeature(ctx.guildId, "digest", true, ctx.userId);
        await replyEphemeral(ctx, infoEmbed("Digest enabled", "Make sure a digest channel is mapped: `/channels set kind:digest channel:#...`"));
        return;
      }
      if (sub === "disable") {
        await tenant.setFeature(ctx.guildId, "digest", false, ctx.userId);
        await replyEphemeral(ctx, infoEmbed("Digest disabled", "Recaps stopped. Configuration kept."));
        return;
      }

      const raw = ctx.interaction.options.getString("hours", true);
      const hours = raw
        .split(/[,\s]+/)
        .map((h) => Number(h))
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
        .slice(0, 6);
      if (!hours.length) {
        await replyEphemeral(ctx, infoEmbed("No valid hours", "Provide integers 0-23, e.g. `9,21`.", 0xed4245));
        return;
      }
      await tenant.patchPreferences(ctx.guildId, { digestHours: hours }, ctx.userId);
      await replyEphemeral(ctx, infoEmbed("Digest hours updated", `Recap fires at ${hours.join(":00, ")}:00 local time.`));
    },
  });

  // ── sources ─────────────────────────────────────────────────────────────────
  commands.push({
    name: "sources",
    definition: new SlashCommandBuilder()
      .setName("sources")
      .setDescription("Opportunity sources feeding this deployment (global, curated)")
      .addSubcommand((s) => s.setName("list").setDescription("List sources and their health"))
      .addSubcommand((s) =>
        s
          .setName("toggle")
          .setDescription("Enable or disable a global source for this deployment")
          .addStringOption((o) => o.setName("source").setDescription("Source id, e.g. hackathon-api").setRequired(true))
          .addBooleanOption((o) => o.setName("enabled").setDescription("true = on").setRequired(true)),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const sub = ctx.interaction.options.getSubcommand(true);

      if (sub === "list") {
        const health = await getSourceHealth(ctx.deps.db);
        const counts = await getOpportunityCountBySource(ctx.deps.db);
        const countMap = new Map(counts.map((c) => [c.sourceId, c]));
        const lines = health.map((h) => {
          const c = countMap.get(h.id);
          const state = h.enabled ? (h.consecutiveFailures > 0 && !h.lastSuccessAt ? "🔴 failing" : "🟢 ok") : "⚪ disabled";
          return `${state} \`${h.id}\` (${h.kind}) every ${Math.round(h.intervalMinutes / 60)}h - stored ${c?.open ?? 0} open / ${c?.total ?? 0}${h.lastError ? ` - last error: ${h.lastError.slice(0, 60)}` : ""}`;
        });
        await replyEphemeral(ctx, infoEmbed("Opportunity sources", lines.join("\n") || "No sources configured."));
        return;
      }

      const source = ctx.interaction.options.getString("source", true).trim();
      const enabled = ctx.interaction.options.getBoolean("enabled", true);
      try {
        await setSourceEnabled(ctx.deps.db, source, enabled ? 1 : 0);
        await ctx.deps.tenant.recordAudit(ctx.guildId, ctx.userId, "source.toggle", { source, enabled });
        await replyEphemeral(ctx, infoEmbed("Source updated", `\`${source}\` is ${enabled ? "enabled" : "disabled"} deployment-wide.`));
      } catch {
        await replyEphemeral(ctx, infoEmbed("Unknown source", `No source with id \`${source}\`.`, 0xed4245));
      }
    },
  });

  return commands;
}
