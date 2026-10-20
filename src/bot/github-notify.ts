import { EmbedBuilder } from "discord.js";
import type { NormalizedGithubEvent } from "../projects/webhooks/verify.js";
import type { EmbedPayload } from "../opportunities/delivery/delivery-service.js";
import { formatInTz } from "../core/time/tz.js";

/** Discord embeds for GitHub project events (activity + CI failure alerts). */
export function buildProjectEmbed(event: NormalizedGithubEvent, timezone = "UTC"): EmbedBuilder {
  const color = event.isFailure ? 0xed4245 : 0x5865f2;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(buildTitle(event))
    .setDescription(buildDescription(event))
    .setTimestamp(event.occurredAt);

  if (event.summary.htmlUrl) embed.setURL(event.summary.htmlUrl);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (event.summary.branch) fields.push({ name: "Branch", value: event.summary.branch.slice(0, 100), inline: true });
  if (event.summary.workflowName) fields.push({ name: "Workflow", value: event.summary.workflowName.slice(0, 100), inline: true });
  if (event.summary.conclusion) fields.push({ name: "Result", value: event.summary.conclusion.slice(0, 60), inline: true });
  if (event.summary.sha) fields.push({ name: "Commit", value: `\`${event.summary.sha.slice(0, 8)}\``, inline: true });
  if (event.summary.releaseTag) fields.push({ name: "Release", value: event.summary.releaseTag.slice(0, 60), inline: true });
  if (event.summary.pullNumber) fields.push({ name: "Pull request", value: `#${event.summary.pullNumber}`, inline: true });
  if (event.summary.issueNumber) fields.push({ name: "Issue", value: `#${event.summary.issueNumber}`, inline: true });
  if (event.summary.deploymentStatus) fields.push({ name: "Status", value: event.summary.deploymentStatus.slice(0, 40), inline: true });
  fields.push({ name: "Occurred", value: `${formatInTz(event.occurredAt, timezone)}`, inline: false });
  embed.addFields(fields.slice(0, 8));
  embed.setFooter({ text: `${event.repoFullName}${event.actor ? ` - actor ${event.actor}` : ""}` });
  return embed;
}

function buildTitle(event: NormalizedGithubEvent): string {
  switch (event.eventType) {
    case "push":
      return `Push to ${event.summary.branch ?? "unknown branch"}`;
    case "pull_request":
      return `Pull request ${event.action ?? "updated"}: ${event.summary.pullTitle?.slice(0, 120) ?? `#${event.summary.pullNumber}`}`;
    case "issues":
      return `Issue ${event.action ?? "updated"}: ${event.summary.issueTitle?.slice(0, 120) ?? `#${event.summary.issueNumber}`}`;
    case "release":
      return `Release ${event.summary.releaseTag ?? "unknown"} ${event.action ?? ""}`.trim();
    case "workflow_run":
      return event.summary.conclusion === "failure"
        ? `CI failure: ${event.summary.workflowName ?? "workflow"}`
        : `CI ${event.summary.conclusion ?? event.summary.deploymentStatus ?? "update"}: ${event.summary.workflowName ?? "workflow"}`;
    case "check_run":
      return `Check ${event.summary.conclusion ?? "update"}: ${event.summary.workflowName ?? "check"}`;
    case "deployment_status":
      return `Deployment ${event.summary.deploymentStatus ?? "update"}`;
    default:
      return `GitHub event: ${event.eventType}`;
  }
}

function buildDescription(event: NormalizedGithubEvent): string {
  const parts: string[] = [];
  if (event.summary.commitCount !== undefined && event.summary.commitCount !== null && event.summary.commitCount > 0) {
    parts.push(`${event.summary.commitCount} commit(s)`);
  }
  if (event.summary.failingStep) parts.push(`failing step: ${event.summary.failingStep}`);
  parts.push("Event processed from a signed GitHub webhook.");
  return parts.join(" - ") || `Repository ${event.repoFullName}`;
}

/** Converts a builder into the transport-safe EmbedPayload shape. */
export function embedToPayload(embed: EmbedBuilder): EmbedPayload {
  return embed.toJSON() as unknown as EmbedPayload;
}
