import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import type { OrbitCommand } from "./context.js";
import { requireAdmin, replyEphemeral, infoEmbed } from "./context.js";
import { formatInTz } from "../../core/time/tz.js";
import { getSourceHealth } from "./source-info.js";
/**
 * Core tenant commands: help, setup, status, features, channels, timezone,
 * authorized roles, audit log.
 */

function helpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Orbit: developer opportunities for Indian students")
    .setDescription(
      [
        "Orbit is free for every guild: no premium tier, no locked features.",
        "",
        "**Opportunity commands (everyone)**",
        "`/opportunities` browse latest - `/hackathons` `/internships` `/jobs` `/opensource` filtered lists",
        "`/opportunity id:<id>` full detail - `/search query:<text>` - `/deadline` upcoming deadlines",
        "`/subscribe` `/unsubscribe` personal deadline interest",
        "",
        "**Configuration (admins only)**",
        "`/setup` guided configuration - `/status` tenant snapshot",
        "`/features` enable or disable capability groups",
        "`/channels` map channel kinds (opportunities, digest, deadlines, infrastructure)",
        "`/preferences` keyword and filter tuning - `/digest` digest schedule",
        "`/sources` view and manage opportunity sources - `/timezone` set guild timezone",
        "`/authorized-roles` add or remove admins by role or user - `/audit-log` recent actions",
        "`/project` register external projects that push health and failures into their own channel",
        "",
        "Setup and configuration are restricted to server administrators and",
        "principals authorized via /authorized-roles. Everyone can browse with the",
        "opportunity commands above.",
      ].join("\n"),
    )
    .setFooter({ text: "All data UTC storage, tenant timezone display" });
}

export function coreCommands(): OrbitCommand[] {
  const commands: OrbitCommand[] = [];

  commands.push({
    name: "help",
    definition: new SlashCommandBuilder()
      .setName("help")
      .setDescription("Orbit feature and command guide"),
    adminOnly: false,
    handler: async (ctx) => {
      await replyEphemeral(ctx, helpEmbed());
    },
  });

  commands.push({
    name: "setup",
    definition: new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Guided configuration steps for this server")
      .addStringOption((o) =>
        o
          .setName("topic")
          .setDescription("What to configure")
          .setRequired(false)
          .addChoices(
            { name: "overview", value: "overview" },
            { name: "channels", value: "channels" },
            { name: "timezone", value: "timezone" },
            { name: "digest", value: "digest" },
            { name: "features", value: "features" },
          ),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const topic = ctx.interaction.options.getString("topic") ?? "overview";
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("Orbit setup").setTimestamp(new Date());
      switch (topic) {
        case "channels":
          embed.setDescription(
            [
              "Map feeds to channels with `/channels`:",
              "",
              "`/channels set kind:opportunities channel:#feeds` - instant announcements",
              "`/channels set kind:digest channel:#daily-digest` - scheduled recap",
              "`/channels set kind:deadlines channel:#deadlines` - pre-deadline reminders",
              "`/channels set kind:infrastructure channel:#ops` - deployment watchdog feed",
              "",
              "Each kind can also carry a mention role: `/channels set kind:... mention:@role`.",
            ].join("\n"),
          );
          break;
        case "timezone":
          embed.setDescription(
            [
              "Times render in this server's timezone (defaults to the deployment default, IST-first).",
              "Set it with `/timezone tz:Asia/Kolkata` (any IANA name works).",
              "Deadlines, digests and reports all use it.",
            ].join("\n"),
          );
          break;
        case "digest":
          embed.setDescription(
            [
              "`/digest hours:9 21` - daily recap times in this server's local clock.",
              "`/digest preview` - see the current queue as a digest embed.",
            ].join("\n"),
          );
          break;
        case "features":
          embed.setDescription(
            [
              "`/features list` - capability groups and states.",
              "`/features enable kind:opportunities` (also deadline_alerts, digest, ai_summaries, infrastructure_alerts).",
              "`/features disable kind:digest` to pause without deleting config.",
            ].join("\n"),
          );
          break;
        default:
          embed.setDescription(
            [
              "Recommended order:",
              "",
              "1. `/channels set kind:opportunities channel:#your-feed`",
              "2. `/features enable kind:opportunities`",
              "3. `/timezone tz:Asia/Kolkata`",
              "4. `/sources list` then tune with `/preferences`",
              "5. `/setup topic:digest`",
              "",
              "You are done once `/status` shows every row green. Config commands are audit-logged.",
            ].join("\n"),
          );
      }
      await replyEphemeral(ctx, embed);
    },
  });

  commands.push({
    name: "status",
    definition: new SlashCommandBuilder().setName("status").setDescription("Snapshot of this server's Orbit configuration"),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const { tenant } = ctx.deps;
      const [guild, features, channels, prefs, health] = await Promise.all([
        tenant.getGuild(ctx.guildId),
        tenant.getFeatures(ctx.guildId),
        tenant.getChannels(ctx.guildId),
        tenant.getPreferences(ctx.guildId),
        getSourceHealth(ctx.deps.db),
      ]);

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("Orbit status")
        .setDescription(
          guild
            ? `Tenant \`${ctx.guildId}\`${guild.name ? ` (${guild.name})` : ""} - timezone ${ctx.tz}`
            : `Tenant \`${ctx.guildId}\` (unregistered, using defaults)`,
        )
        .addFields(
          {
            name: "Features",
            value: [...features.entries()].map(([k, v]) => `${v ? "🟢" : "⚪"} ${k}`).join("\n") || "none",
            inline: true,
          },
          {
            name: "Channels",
            value: channels.length ? channels.map((c) => `${c.kind}: <#${c.channelId}>`).join("\n") : "none mapped",
            inline: true,
          },
          {
            name: "Preferences",
            value: [
              `categories: ${prefs.enabledCategories.length ? prefs.enabledCategories.join(", ") : "all"}`,
              `keywords: ${prefs.includeKeywords.join(", ") || "-"}`,
              `exclude: ${prefs.excludeKeywords.join(", ") || "-"}`,
              `remote-only: ${prefs.remoteOnly ? "yes" : "no"}`,
            ].join("\n"),
            inline: false,
          },
          { name: "Source health", value: health
              .map(
                (h) =>
                  `${h.consecutiveFailures > 0 && !h.lastSuccessAt ? "🔴" : "🟢"} ${h.id}${h.lastError ? ` (${h.lastError.slice(0, 60)})` : ""}`,
              )
              .join("\n") || "no sources",
            inline: true,
          },
          {
            name: "Digest hours (tenant local)",
            value: prefs.digestHours.join(", "),
            inline: true,
          },
        )
        .setFooter({ text: `Timezone: ${ctx.tz}` });

      await replyEphemeral(ctx, embed);
    },
  });

  commands.push({
    name: "timezone",
    definition: new SlashCommandBuilder()
      .setName("timezone")
      .setDescription("Set the tenant timezone used for every display and digest")
      .addStringOption((o) => o.setName("tz").setDescription("IANA timezone, e.g. Asia/Kolkata").setRequired(true)),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const tz = ctx.interaction.options.getString("tz", true);
      try {
        await ctx.deps.tenant.setGuildTimezone(ctx.guildId, tz, ctx.userId);
        await ctx.deps.tenant.recordAudit(ctx.guildId, ctx.userId, "timezone.set", { tz });
        const sample = formatInTz(new Date(), tz);
        await replyEphemeral(ctx, infoEmbed("Timezone updated", `Times now render as: **${sample}**`));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown timezone";
        await replyEphemeral(ctx, infoEmbed("Invalid timezone", message, 0xed4245));
      }
    },
  });

  commands.push({
    name: "authorized-roles",
    definition: new SlashCommandBuilder()
      .setName("authorized-roles")
      .setDescription("Control who may configure Orbit besides administrators")
      .addSubcommand((s) => s.setName("list").setDescription("List authorized roles and users"))
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Grant a role or user configuration access")
          .addRoleOption((o) => o.setName("role").setDescription("Role to authorize"))
          .addUserOption((o) => o.setName("user").setDescription("User to authorize")),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Revoke a role or user")
          .addStringOption((o) => o.setName("principal").setDescription("Role or user ID to revoke").setRequired(true)),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const tenant = ctx.deps.tenant;
      const sub = ctx.interaction.options.getSubcommand(true);

      if (sub === "list") {
        const principals = await tenant.listAuthorizedPrincipals(ctx.guildId);
        await replyEphemeral(
          ctx,
          infoEmbed("Authorized principals", principals.length ? principals.map((p) => `<@${p}> (\`${p}\`)`).join("\n") : "Only administrators can configure Orbit."),
        );
        return;
      }

      if (sub === "add") {
        const role = ctx.interaction.options.getRole("role");
        const user = ctx.interaction.options.getUser("user");
        const principal = role?.id ?? user?.id;
        if (!principal) {
          await replyEphemeral(ctx, infoEmbed("Nothing to add", "Pick a role or a user.", 0xed4245));
          return;
        }
        await tenant.addAuthorizedPrincipal(ctx.guildId, principal, ctx.userId);
        await tenant.recordAudit(ctx.guildId, ctx.userId, "authorized.add", { principal });
        await replyEphemeral(ctx, infoEmbed("Principal authorized", `<@${principal}> can now configure Orbit in this server.`));
        return;
      }

      const principal = ctx.interaction.options.getString("principal", true);
      await tenant.removeAuthorizedPrincipal(ctx.guildId, principal, ctx.userId);
      await tenant.recordAudit(ctx.guildId, ctx.userId, "authorized.remove", { principal });
      await replyEphemeral(ctx, infoEmbed("Principal revoked", `Access removed for \`${principal}\`.`));
    },
  });

  commands.push({
    name: "audit-log",
    definition: new SlashCommandBuilder()
      .setName("audit-log")
      .setDescription("Recent configuration actions in this server")
      .addIntegerOption((o) => o.setName("limit").setDescription("How many entries (max 25)").setRequired(false)),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const limit = Math.min(Math.max(ctx.interaction.options.getInteger("limit") ?? 15, 1), 25);
      const entries = await ctx.deps.tenant.getAuditLog(ctx.guildId, limit);
      const lines = entries.map(
        (e) => `<t:${Math.floor(e.createdAt.getTime() / 1000)}:R> <@${e.actorId}> ${e.action} \`${JSON.stringify(e.target).slice(0, 80)}\``,
      );
      const embed = infoEmbed("Audit log (this server)", lines.join("\n") || "No actions recorded yet.", 0xfee75c);
      await replyEphemeral(ctx, embed);
    },
  });

  return commands;
}
