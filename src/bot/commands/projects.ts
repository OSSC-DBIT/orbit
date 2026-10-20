import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { OrbitCommand } from "./context.js";
import { requireAdmin, replyEphemeral, infoEmbed, truncate } from "./context.js";
import { projectEvents, workflowRuns, githubWebhookDeliveries } from "../../database/schema/index.js";
import { formatInTz } from "../../core/time/tz.js";
import { ValidationError } from "../../core/errors/index.js";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseRepo(raw: string): string {
  const value = raw.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!REPO_PATTERN.test(value) || value.split("/").length !== 2) {
    throw new ValidationError("Repository must look like `owner/name` (or a github.com URL).");
  }
  return value.toLowerCase();
}

/** Project monitoring commands backed by signed GitHub webhooks. */
export function projectCommands(): OrbitCommand[] {
  const commands: OrbitCommand[] = [];

  commands.push({
    name: "project",
    definition: new SlashCommandBuilder()
      .setName("project")
      .setDescription("Monitor GitHub repositories in this server")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Start monitoring a repository")
          .addStringOption((o) => o.setName("repo").setDescription("owner/name (or a github.com URL)").setRequired(true))
          .addBooleanOption((o) => o.setName("activity").setDescription("Also announce every push/PR (default only failures)").setRequired(false))
          .addStringOption((o) => o.setName("categories").setDescription("Comma list: push,pull_request,issues,release,workflow_run,deployment_status")),
      )
      .addSubcommand((s) => s.setName("list").setDescription("Monitored repositories"))
      .addSubcommand((s) => s
        .setName("status")
        .setDescription("Latest events for a repository")
        .addStringOption((o) => o.setName("repo").setDescription("owner/name").setRequired(true)))
      .addSubcommand((s) => s
        .setName("remove")
        .setDescription("Stop monitoring a repository")
        .addStringOption((o) => o.setName("repo").setDescription("owner/name").setRequired(true)))
      .addSubcommand((s) => s
        .setName("logs")
        .setDescription("Recent workflow failures (with diagnosed cause)")
        .addStringOption((o) => o.setName("repo").setDescription("owner/name").setRequired(true)))
      .addSubcommand((s) => s
        .setName("report")
        .setDescription("Weekly activity report")
        .addStringOption((o) => o.setName("repo").setDescription("owner/name").setRequired(true)))
      .addSubcommand((s) => s
        .setName("alerts")
        .setDescription("Where CI failures post: set this server's github_alerts channel")
        .addChannelOption((o) => o.setName("channel").setDescription("Alerts channel").setRequired(true)))
      .addSubcommand((s) => s.setName("health").setDescription("Webhook delivery health for this server")),
    adminOnly: false,
    handler: async (ctx) => {
      // list/status/logs/report/health can run for any member; mutations need admin
      const sub = ctx.interaction.options.getSubcommand(true);
      if (sub === "add" || sub === "remove" || sub === "alerts") {
        await requireAdmin(ctx);
      }

      const tenant = ctx.deps.tenant;
      const db = ctx.deps.db;

      if (sub === "alerts") {
        const channel = ctx.interaction.options.getChannel("channel", true);
        await tenant.setChannel(ctx.guildId, "github_alerts", channel.id, ctx.userId, null);
        await replyEphemeral(ctx, infoEmbed("Alerts channel bound", `CI failures for monitored repos now post in <#${channel.id}>.`));
        return;
      }

      if (sub === "add") {
        try {
          const repo = parseRepo(ctx.interaction.options.getString("repo", true));
          const activity = ctx.interaction.options.getBoolean("activity") ?? false;
          const categoriesRaw = ctx.interaction.options.getString("categories") ?? "";
          const categories = categoriesRaw.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
          await tenant.upsertGuildProject({
            guildId: ctx.guildId,
            repositoryFullName: repo,
            notifyActivity: activity ? 1 : 0,
            alertCategories: categories,
            addedBy: ctx.userId,
          });
          await tenant.recordAudit(ctx.guildId, ctx.userId, "project.add", { repo, activity });
          const featureOn = await tenant.isFeatureEnabled(ctx.guildId, "github_projects");
          const slug = ctx.deps.config.GITHUB_APP_SLUG;
          const installLine = slug
            ? `Install the app in one click: https://github.com/apps/${slug}/installations/new (choose this server, grant it access to ${repo}).`
            : "To activate events, install the Orbit GitHub App with webhooks pointed at this deployment.";
          await replyEphemeral(
            ctx,
            infoEmbed(
              "Repository queued",
              featureOn
                ? [
                    `\`${repo}\` is monitored.`,
                    "",
                    installLine,
                    "",
                    "Events begin flowing once the first webhook delivery for the repository lands (also flips it to verified).",
                  ].join("\n")
                : [`\`${repo}\` stored, but the \`github_projects\` feature is disabled in this server. Enable it: \`/features enable kind:github_projects\` and map a channel with \`/project alerts\`.`].join("\n"),
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "invalid repository";
          await replyEphemeral(ctx, infoEmbed("Could not add repository", message, 0xed4245));
        }
        return;
      }

      if (sub === "remove") {
        const repo = parseRepo(ctx.interaction.options.getString("repo", true));
        const removed = await tenant.removeGuildProject(ctx.guildId, repo);
        await tenant.recordAudit(ctx.guildId, ctx.userId, "project.remove", { repo });
        await replyEphemeral(ctx, infoEmbed(removed ? "Removed" : "Not monitored", removed ? `\`${repo}\` is no longer monitored here.` : `\`${repo}\` was not in this server's list.`));
        return;
      }

      if (sub === "list") {
        const rows = (await tenant.listGuildProjects(ctx.guildId))
          .sort((a, b) => a.repositoryFullName.localeCompare(b.repositoryFullName))
          .slice(0, 30);
        const lines = rows.map((r) => `${r.verified ? "🟢" : "🟡"} \`${r.repositoryFullName}\` - ${r.notifyActivity ? "activity on" : "failures only"}${r.alertCategories.length ? ` (${r.alertCategories.join(", ")})` : ""}`);
        await replyEphemeral(ctx, infoEmbed(`Monitored projects (${rows.length})`, lines.join("\n") || "Nothing monitored yet. `/project add repo:owner/name`"));
        return;
      }

      if (sub === "status") {
        const repo = parseRepo(ctx.interaction.options.getString("repo", true));
        const project = await tenant.findGuildProject(ctx.guildId, repo);
        if (!project) {
          await replyEphemeral(ctx, infoEmbed("Not monitored", `\`${repo}\` is not monitored in this server.`, 0xed4245));
          return;
        }
        const events = await db
          .select()
          .from(projectEvents)
          .where(and(eq(projectEvents.guildId, ctx.guildId), eq(projectEvents.repositoryFullName, repo)))
          .orderBy(desc(projectEvents.occurredAt))
          .limit(10);
        const runs = await db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.repositoryFullName, repo))
          .orderBy(desc(workflowRuns.updatedAt))
          .limit(5);

        const embed = new EmbedBuilder()
          .setColor(project.verified ? 0x57f287 : 0xfaa61a)
          .setTitle(`Project status: ${repo}`)
          .setDescription(
            [
              project.verified ? "Webhook events verified for this repo." : "Awaiting first webhook event (repo not yet verified).",
              runs.length
                ? `Latest workflow: **${truncate(runs[0]!.workflowName ?? "workflow", 60)}** ${runs[0]!.conclusion ?? runs[0]!.status ?? "unknown"} on \`${truncate(runs[0]!.headBranch ?? "?", 24)}\``
                : "No workflow runs recorded yet.",
            ].join("\n"),
          );
        for (const e of events) {
          const p = e.payload as { actor?: string | null; summary?: Record<string, unknown> };
          const detail = p.summary ? Object.values(p.summary).map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : "")).filter(Boolean).slice(0, 3).join(" - ") : "";
          embed.addFields({
            name: `${e.severity === "alert" ? "🔴" : "🔵"} ${e.eventType}`,
            value: `${formatInTz(e.occurredAt, ctx.tz)}${p.actor ? ` by ${p.actor}` : ""}${detail ? `\n${truncate(detail, 180)}` : ""}`,
            inline: false,
          });
        }
        if (!events.length) embed.addFields({ name: "Events", value: "No events captured yet.", inline: false });
        await replyEphemeral(ctx, embed);
        return;
      }

      if (sub === "logs") {
        const repo = parseRepo(ctx.interaction.options.getString("repo", true));
        const failed = await db
          .select()
          .from(workflowRuns)
          .where(and(eq(workflowRuns.repositoryFullName, repo), eq(workflowRuns.conclusion, "failure")))
          .orderBy(desc(workflowRuns.updatedAt))
          .limit(5);
        if (!failed.length) {
          await replyEphemeral(ctx, infoEmbed("No failures", `No failed workflow runs recorded for \`${repo}\`.`, 0x57f287));
          return;
        }
        const lines: string[] = [];
        for (const run of failed) {
          let diagnosis = "";
          if (ctx.deps.diagnostics && run.runId) {
            try {
              const d = await ctx.deps.diagnostics.diagnose(repo, run.runId);
              diagnosis = d.aiDiagnosis ?? d.deterministicSummary;
            } catch {
              diagnosis = "";
            }
          }
          lines.push(
            [
              `**${truncate(run.workflowName ?? "workflow", 60)}** ${formatInTz(run.updatedAt, ctx.tz)}`,
              run.htmlUrl ? `<${run.htmlUrl}>` : "",
              diagnosis ? `Diagnosis: ${truncate(diagnosis, 350)}` : "",
            ].filter(Boolean).join("\n"),
          );
        }
        await replyEphemeral(ctx, infoEmbed(`Recent failures: ${repo}`, lines.join("\n\n"), 0xed4245));
        return;
      }

      if (sub === "report") {
        const repo = parseRepo(ctx.interaction.options.getString("repo", true));
        if (!ctx.deps.reports) {
          await replyEphemeral(ctx, infoEmbed("Reports unavailable", "The report service is not wired in this deployment.", 0xed4245));
          return;
        }
        const report = await ctx.deps.reports.build(ctx.guildId, repo, ctx.deps.ai, ctx.tz);
        if (!report) {
          await replyEphemeral(ctx, infoEmbed("No report", "Could not build the report.", 0xed4245));
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Weekly report: ${report.repository}`)
          .setDescription(report.narrative ?? "*AI narrative unavailable; deterministic summary below.*")
          .addFields(
            { name: "Workflow summary", value: report.workflowSummary, inline: false },
            {
              name: "Event totals (7 days)",
              value: Object.entries(report.totals).map(([k, v]) => `${k}: ${v}`).join("\n") || "no events",
              inline: true,
            },
            {
              name: "Alerts",
              value: report.alerts.length ? report.alerts.map((a) => `${a.at} ${a.note}`).join("\n").slice(0, 1000) : "none",
              inline: false,
            },
          );
        await replyEphemeral(ctx, embed);
        return;
      }

      if (sub === "health") {
        const monitored = await tenant.listGuildProjects(ctx.guildId);
        if (!monitored.length) {
          await replyEphemeral(ctx, infoEmbed("Webhook health", "Monitor a repository first: `/project add repo:owner/name`."));
          return;
        }
        const deliveries = await db
          .select({
            repositoryFullName: sql<string>`repository_full_name`,
            total: sql<number>`count(*)::int`,
            processed: sql<number>`sum(case when status = 'processed' then 1 else 0 end)::int`,
            errored: sql<number>`sum(case when status = 'error' then 1 else 0 end)::int`,
          })
          .from(githubWebhookDeliveries)
          .where(
            and(
              sql`received_at > now() - interval '7 days'`,
              // inArray (not any()) — drizzle expands dynamic lists safely;
              // binding a JS array through any() serialized as a malformed
              // array literal and crashed the health view
              inArray(githubWebhookDeliveries.repositoryFullName, monitored.map((m) => m.repositoryFullName)),
            ),
          )
          .groupBy(sql`repository_full_name`)
          // drizzle JS field names (total) are NOT sql aliases; order by the
          // aggregate itself, never by an alias absent from the select list
          .orderBy(sql`count(*) desc`)
          .limit(15);
        const lines = deliveries.map(
          (r) => `${r.errored > 0 ? "🔴" : "🟢"} \`${r.repositoryFullName}\`: ${r.processed}/${r.total} processed in 7 days`,
        );
        await replyEphemeral(ctx, infoEmbed("Webhook health (7 days)", lines.join("\n") || "No webhook deliveries recorded yet."));
        return;
      }

      void sub;
    },
  });

  return commands;
}
