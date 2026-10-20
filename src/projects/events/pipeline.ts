import type { Database } from "../../database/client.js";
import { getDb } from "../../database/client.js";
import { and, eq, sql } from "drizzle-orm";
import { githubWebhookDeliveries, guildProjects, projectEvents, workflowRuns } from "../../database/schema/index.js";
import type { NormalizedGithubEvent } from "../webhooks/verify.js";
import { newCorrelationId } from "../../core/ids.js";
import { getLogger, scopedLogger } from "../../core/logging/logger.js";

/**
 * Event pipeline: stores the delivery (dedup by delivery id), fan-outs the
 * normalized event to every tenant that monitors the repository with the
 * event's category enabled, stores project_events with an idempotent
 * fingerprint, and emits an in-process notification payload list for the
 * Discord layer.
 */
export interface TenantTarget {
  guildId: string;
  severity: "activity" | "alert";
}

export interface PipelineOutput {
  correlationId: string;
  targets: TenantTarget[];
  run?: WorkflowRunRow;
}

export interface WorkflowRunRow {
  repositoryFullName: string;
  runId: string;
  workflowName: string | null;
  headBranch: string | null;
  headSha: string | null;
  conclusion: string | null;
  htmlUrl: string | null;
  actor: string | null;
}

const DEFAULT_ACTIVITY_CATEGORIES = ["push", "pull_request", "issues", "release", "workflow_run", "deployment_status"];

export class EventPipeline {
  constructor(private db: Database = getDb()) {}

  /**
   * Idempotent per delivery id: second delivery of the same GUID short-circuits.
   */
  async process(deliveryId: string, event: NormalizedGithubEvent): Promise<PipelineOutput | "duplicate"> {
    const correlationId = newCorrelationId("git");
    const log = scopedLogger(getLogger(), { correlationId, deliveryId, repo: event.repoFullName });

    const claimed = await this.db
      .insert(githubWebhookDeliveries)
      .values({
        deliveryId,
        repositoryFullName: event.repoFullName,
        eventType: event.eventType,
      })
      .onConflictDoNothing()
      .returning({ id: githubWebhookDeliveries.id });
    if (!claimed.length) return "duplicate";

    try {
      const repo = event.repoFullName;

      // workflow_run bookkeeping
      let run: WorkflowRunRow | undefined;
      if (event.eventType === "workflow_run" && event.summary.workflowRunId) {
        const row = {
          repositoryFullName: repo,
          runId: event.summary.workflowRunId,
          workflowName: event.summary.workflowName ?? null,
          headBranch: event.summary.branch ?? null,
          headSha: event.summary.sha ?? null,
          event: event.action ?? null,
          status: event.summary.deploymentStatus ?? null,
          conclusion: event.summary.conclusion ?? null,
          htmlUrl: event.summary.htmlUrl ?? null,
          actor: event.actor ?? null,
          updatedAt: new Date(),
        };
        await this.db
          .insert(workflowRuns)
          .values(row)
          .onConflictDoUpdate({ target: [workflowRuns.repositoryFullName, workflowRuns.runId], set: row });
        run = {
          repositoryFullName: row.repositoryFullName,
          runId: row.runId,
          workflowName: row.workflowName,
          headBranch: row.headBranch,
          headSha: row.headSha,
          conclusion: row.conclusion,
          htmlUrl: row.htmlUrl,
          actor: row.actor,
        };
      }

      // tenants monitoring this repo (cross-tenant table read is intentional
      // here: the system dispatcher needs the full fan-out list)
      const associations = await this.db
        .select()
        .from(guildProjects)
        .where(and(eq(guildProjects.repositoryFullName, repo), eq(guildProjects.verified, 1)));

      const targets: TenantTarget[] = [];
      for (const association of associations) {
        // First webhook is the ownership handshake for the repo: verify the
        // association and record the installation that delivered the event.
        if (association.verified !== 1) {
          await this.db
            .update(guildProjects)
            .set({
              verified: 1,
              installationId: event.installationId ?? association.installationId ?? null,
            })
            .where(eq(guildProjects.id, association.id));
        }

        const wanted = association.alertCategories.length
          ? association.alertCategories
          : DEFAULT_ACTIVITY_CATEGORIES;
        if (!wanted.includes(event.action ?? event.eventType) && !wanted.includes(event.eventType)) continue;

        const severity: TenantTarget["severity"] = event.isFailure ? "alert" : association.notifyActivity === 1 ? "activity" : "activity";
        if (severity === "activity" && association.notifyActivity !== 1 && !event.isFailure) {
          // activity feed disabled and not a failure: no notify
          continue;
        }

        const inserted = await this.db
          .insert(projectEvents)
          .values({
            guildId: association.guildId,
            repositoryFullName: repo,
            eventType: event.eventType,
            eventFingerprint: `${association.guildId.slice(0, 12)}:${event.fingerprint}`.slice(0, 80),
            deliveryId,
            payload: event as unknown as Record<string, unknown>,
            occurredAt: event.occurredAt,
            severity,
          })
          .onConflictDoNothing()
          .returning({ id: projectEvents.id });
        if (!inserted.length) continue; // replay or duplicate within tenant

        targets.push({ guildId: association.guildId, severity });
      }

      await this.db
        .update(githubWebhookDeliveries)
        .set({ processedAt: new Date(), status: "processed" })
        .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));

      log.info({ targetCount: targets.length }, "github event processed");
      return { correlationId, targets, run };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(githubWebhookDeliveries)
        .set({ status: "error", error: message.slice(0, 500) })
        .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));
      throw err;
    }
  }

  /** Tenant health view used by /project status. */
  async recentEvents(guildId: string, repoFullName: string, limit = 10): Promise<Array<{ eventType: string; severity: string; occurredAt: Date; payload: Record<string, unknown> }>> {
    const rows = await this.db
      .select()
      .from(projectEvents)
      .where(and(eq(projectEvents.guildId, guildId), eq(projectEvents.repositoryFullName, repoFullName)))
      .orderBy(sql`occurred_at desc`)
      .limit(limit);
    return rows.map((r) => ({ eventType: r.eventType, severity: r.severity, occurredAt: r.occurredAt, payload: r.payload }));
  }
}
