import { SlashCommandBuilder, type SlashCommandStringOption } from "discord.js";
import type { OrbitCommand } from "./context.js";
import { requireAdmin, replyEphemeral, infoEmbed, errorEmbed } from "./context.js";
import { newToken } from "../../core/security/crypto.js";
import { tokenHash } from "../../monitoring/infra.js";
import { PUBLIC_URL } from "../../api/pages.js";

/**
 * Project monitoring (admin): register external projects that push status
 * events into Orbit via the bearer token ingest API. Announcements land in
 * the project's own channel (falls back to the guild "infrastructure"
 * binding); a watchdog flags projects that stop heartbeating.
 */

const NAME_PATTERN = /^[A-Za-z0-9 ._\-]{1,64}$/;

function nameOpt() {
  return (o: SlashCommandStringOption) =>
    o.setName("name").setDescription("Project name (as registered)").setRequired(true);
}

function iconFor(status: string): string {
  return status === "active" ? "🟢" : status === "stale" ? "🔴" : "🟡";
}

export function projectCommands(): OrbitCommand[] {
  const commands: OrbitCommand[] = [];
  const adminNote = "Registered and controlled by server admins.";

  commands.push({
    name: "project",
    definition: new SlashCommandBuilder()
      .setName("project")
      .setDescription("Monitor your other projects: push events, heartbeats and outages into this server")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Register a project and get its push token")
          .addStringOption((o) => o.setName("name").setDescription("Project name, e.g. payments-api").setRequired(true))
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Channel for this project's status posts").setRequired(false).addChannelTypes(0, 5),
          )
          .addStringOption((o) => o.setName("url").setDescription("Project home URL (plain text, optional)")),
      )
      .addSubcommand((s) => s.setName("list").setDescription("List registered project monitors"))
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a project monitor and revoke its token")
          .addStringOption(nameOpt()),
      )
      .addSubcommand((s) =>
        s
          .setName("token")
          .setDescription("Rotate the push token (old token stops working)")
          .addStringOption(nameOpt()),
      )
      .addSubcommand((s) =>
        s
          .setName("channel")
          .setDescription("Rebind the channel a project posts into")
          .addStringOption(nameOpt())
          .addChannelOption((o) =>
            o.setName("channel").setDescription("New target channel").setRequired(true).addChannelTypes(0, 5),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("test")
          .setDescription("Send a test status post to the project's channel")
          .addStringOption(nameOpt()),
      ),
    adminOnly: true,
    handler: async (ctx) => {
      await requireAdmin(ctx);
      const sub = ctx.interaction.options.getSubcommand(true);
      const tenant = ctx.deps.tenant;
      const infra = ctx.deps.infra;

      // ── add ─────────────────────────────────────────────────────────────────
      if (sub === "add") {
        const rawName = ctx.interaction.options.getString("name", true).trim();
        if (!NAME_PATTERN.test(rawName)) {
          await replyEphemeral(
            ctx,
            errorEmbed("Invalid name", "Use 1 to 64 characters: letters, numbers, spaces, dot, dash, underscore."),
          );
          return;
        }
        const channel = ctx.interaction.options.getChannel("channel");
        const rawUrl = ctx.interaction.options.getString("url")?.trim() ?? "";
        if (rawUrl.length > 300) {
          await replyEphemeral(ctx, errorEmbed("URL too long", "Keep the home URL under 300 characters."));
          return;
        }
        const token = newToken(32);
        const id = await tenant.registerInfraProject(ctx.guildId, {
          name: rawName,
          homeUrl: rawUrl || null,
          notifyChannelId: channel?.id ?? null,
          slaMinutes: 60,
          enrolTokenHash: tokenHash(token),
          addedBy: ctx.userId,
        });
        const base = `${PUBLIC_URL}/api/projects/${id}`;
        const lines = [
          `Channel ${channel ? `<#${channel.id}>` : "not bound yet (\`/project channel\`)"}, watchdog 60 min.`,
          "",
          `**Events**  \`POST ${base}/events\``,
          `**Beat**    \`POST ${base}/heartbeat\``,
          "",
          `Bearer token (shown once): ||${token}||`,
          "",
          "Quick check:",
          `\`curl -X POST "${base}/heartbeat" -H "Authorization: Bearer <token>"\``,
          `Then run \`/project test name:${rawName}\` to confirm Discord posting works.`,
          adminNote,
        ];
        await replyEphemeral(ctx, infoEmbed("Project registered", lines.join("\n")));
        return;
      }

      // ── list ────────────────────────────────────────────────────────────────
      if (sub === "list") {
        const rows = await tenant.listInfraProjects(ctx.guildId);
        if (rows.length === 0) {
          await replyEphemeral(ctx, infoEmbed("No project monitors", "Register one with \`/project add\`."));
          return;
        }
        const lines = rows.map(
          (r) =>
            `${iconFor(r.status)} **${r.name}** | ${r.notifyChannelId ? `<#${r.notifyChannelId}>` : "no channel"} | watchdog ${r.slaMinutes}m | last beat ${ctx.fmt(r.lastHeartbeatAt)}`,
        );
        await replyEphemeral(ctx, infoEmbed(`Project monitors (${rows.length})`, lines.join("\n")));
        return;
      }

      // ── remove ──────────────────────────────────────────────────────────────
      if (sub === "remove") {
        const name = ctx.interaction.options.getString("name", true);
        const ok = await tenant.removeInfraProject(ctx.guildId, name, ctx.userId);
        if (!ok) {
          await replyEphemeral(ctx, errorEmbed("Unknown project", `No monitor named \`${name}\` here.`));
          return;
        }
        await replyEphemeral(ctx, infoEmbed("Project removed", `\`${name}\` unregistered and its token revoked.`));
        return;
      }

      // ── token ───────────────────────────────────────────────────────────────
      if (sub === "token") {
        const name = ctx.interaction.options.getString("name", true);
        const token = newToken(32);
        const ok = await tenant.rotateInfraProjectToken(ctx.guildId, name, tokenHash(token), ctx.userId);
        if (!ok) {
          await replyEphemeral(ctx, errorEmbed("Unknown project", `No monitor named \`${name}\` here.`));
          return;
        }
        await replyEphemeral(
          ctx,
          infoEmbed("Token rotated", `New bearer token for \`${name}\` (shown once): ||${token}||`),
        );
        return;
      }

      // ── channel ─────────────────────────────────────────────────────────────
      if (sub === "channel") {
        const name = ctx.interaction.options.getString("name", true);
        const channel = ctx.interaction.options.getChannel("channel", true);
        const ok = await tenant.updateInfraProjectChannel(ctx.guildId, name, channel.id, ctx.userId);
        if (!ok) {
          await replyEphemeral(ctx, errorEmbed("Unknown project", `No monitor named \`${name}\` here.`));
          return;
        }
        // status posts land per-project; the guild "infrastructure" channel
        // binding stays as fallback for projects without a bound channel.
        await replyEphemeral(ctx, infoEmbed("Channel bound", `\`${name}\` now posts into <#${channel.id}>.`));
        return;
      }

      // ── test ────────────────────────────────────────────────────────────────
      if (sub === "test") {
        const name = ctx.interaction.options.getString("name", true);
        const row = await tenant.getInfraProject(ctx.guildId, name);
        if (!row) {
          await replyEphemeral(ctx, errorEmbed("Unknown project", `No monitor named \`${name}\` here.`));
          return;
        }
        const result = await infra.ingestEvent(row, {
          severity: "ok",
          message: `Test signal: ${row.name} events reach this server normally.`,
        });
        if (result.announced) {
          await replyEphemeral(
            ctx,
            infoEmbed("Test posted", "Check the bound channel. Nothing there? Fix bot channel permissions (View, Send Messages, Embed Links)."),
          );
        } else {
          await replyEphemeral(
            ctx,
            infoEmbed(
              "Stored, not announced",
              "Possible causes: no channel bound (\`/project channel\`), no guild fallback (\`/channels set kind:infrastructure\`), or bot lacks View/Send/Embed permission in that channel.",
            ),
          );
        }
        return;
      }
    },
  });

  return commands;
}
