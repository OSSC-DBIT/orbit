import { verifyHmacSha256 } from "../../core/security/crypto.js";

/**
 * GitHub webhook verification and normalization.
 *
 * Requirements implemented:
 *  - HMAC SHA-256 signature check against the configured webhook secret
 *    using a constant-time comparison;
 *  - payload size rejection (GitHub rarely sends events > 25 MB; flows are cut
 *    at 10 MB to bound memory);
 *  - replay/dedup handled downstream via the `X-GitHub-Delivery` id, which is
 *    the canonical per-delivery GUID GitHub generates.
 */

export const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;

export interface VerifiedWebhook {
  deliveryId: string;
  event: string;
  signatureValid: boolean;
  payload: Buffer;
}

export interface WebhookHeaders {
  "x-github-event"?: string;
  "x-github-delivery"?: string;
  "x-hub-signature-256"?: string;
  "content-type"?: string;
  [header: string]: string | undefined;
}

export function verifyWebhook(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string | undefined,
): { ok: boolean; code: "ok" | "invalid-signature" | "missing-signature" | "missing-secret" | "too-large" | "missing-headers"; deliveryId: string | null; event: string | null } {
  const event = headers["x-github-event"]?.toString() ?? null;
  const deliveryId = headers["x-github-delivery"]?.toString() ?? null;
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return { ok: false, code: "too-large", deliveryId, event };
  if (!event || !deliveryId) return { ok: false, code: "missing-headers", deliveryId: null, event: null };

  if (!secret) {
    // Signing secret not configured: running insecure is unacceptable for
    // tenant data. Reject unless the deployment explicitly opted out.
    return { ok: false, code: "missing-secret", deliveryId, event };
  }
  const signature = headers["x-hub-signature-256"];
  const valid = verifyHmacSha256(rawBody, signature, secret);
  if (!valid) {
    return { ok: false, code: signature ? "invalid-signature" : "missing-signature", deliveryId, event };
  }
  return { ok: true, code: "ok", deliveryId, event };
}

/** Extracted fields for the event pipeline. */
export interface NormalizedGithubEvent {
  eventType: string;
  repoFullName: string;
  deliveryId: string;
  actor: string | null;
  occurredAt: Date;
  action: string | null;
  /** GitHub App installation id present on app-delivered webhooks. */
  installationId: string | null;
  fingerprint: string;
  summary: {
    branch?: string | null;
    sha?: string | null;
    workflowName?: string | null;
    workflowRunId?: string | null;
    conclusion?: string | null;
    pullNumber?: number | null;
    pullTitle?: string | null;
    issueNumber?: number | null;
    issueTitle?: string | null;
    releaseTag?: string | null;
    deploymentStatus?: string | null;
    compareUrl?: string | null;
    htmlUrl?: string | null;
    commitCount?: number | null;
    failingStep?: string | null;
    headBranch?: string | null;
    environment?: string | null;
  };
  /** true for failure-class events that need alerts, not activity feed */
  isFailure: boolean;
}

export function normalizeGithubEvent(event: string, deliveryId: string, payload: Record<string, unknown>): NormalizedGithubEvent | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const fullName = repository?.full_name;
  if (typeof fullName !== "string") return null;

  const sender = payload.sender as Record<string, unknown> | undefined;
  const actor = typeof sender?.login === "string" ? sender.login : null;
  const action = typeof payload.action === "string" ? payload.action : null;
  const installation = payload.installation as Record<string, unknown> | undefined;
  const installationId =
    installation?.id !== undefined && installation?.id !== null ? String(installation.id) : null;

  const base = {
    eventType: event,
    repoFullName: fullName,
    deliveryId,
    actor,
    occurredAt: new Date(),
    action,
    installationId,
  };

  switch (event) {
    case "push": {
      const commits = (payload.commits as Array<Record<string, unknown>> | undefined) ?? [];
      const sha = typeof payload.after === "string" ? payload.after : null;
      return {
        ...base,
        occurredAt: new Date(),
        fingerprint: fingerprint(event, fullName, [sha ?? "", String((payload.head_commit as Record<string, unknown>)?.timestamp ?? commits.length)]),
        summary: {
          branch: typeof payload.ref === "string" ? payload.ref.replace("refs/heads/", "") : null,
          sha,
          compareUrl: typeof payload.compare === "string" ? payload.compare : null,
          commitCount: commits.length,
        },
        isFailure: false,
      };
    }
    case "pull_request": {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const number = typeof pr?.number === "number" ? pr.number : null;
      const title = typeof pr?.title === "string" ? pr.title : null;
      const merged = pr?.merged === true;
      const url = typeof pr?.html_url === "string" ? pr.html_url : null;
      return {
        ...base,
        fingerprint: fingerprint(event, fullName, [String(number), action ?? ""]),
        summary: {
          pullNumber: number,
          pullTitle: title,
          htmlUrl: url,
          conclusion: merged ? "merged" : action,
        },
        isFailure: false,
      };
    }
    case "issues": {
      const issue = payload.issue as Record<string, unknown> | undefined;
      const number = typeof issue?.number === "number" ? issue.number : null;
      return {
        ...base,
        fingerprint: fingerprint(event, fullName, [String(number), action ?? ""]),
        summary: {
          issueNumber: number,
          issueTitle: typeof issue?.title === "string" ? issue.title : null,
          htmlUrl: typeof issue?.html_url === "string" ? issue.html_url : null,
        },
        isFailure: false,
      };
    }
    case "release": {
      const release = payload.release as Record<string, unknown> | undefined;
      return {
        ...base,
        fingerprint: fingerprint(event, fullName, [String(release?.id ?? action ?? "release")]),
        summary: {
          releaseTag: typeof release?.tag_name === "string" ? release.tag_name : null,
          htmlUrl: typeof release?.html_url === "string" ? release.html_url : null,
        },
        isFailure: false,
      };
    }
    case "workflow_run": {
      const run = payload.workflow_run as Record<string, unknown> | undefined;
      const conclusion = typeof run?.conclusion === "string" ? run.conclusion : null;
      const status = typeof run?.status === "string" ? run.status : null;
      const workflow = payload.workflow as Record<string, unknown> | undefined;
      return {
        ...base,
        fingerprint: fingerprint(event, fullName, [String(run?.run_number ?? run?.id ?? ""), String(run?.run_attempt ?? ""), String(run?.updated_at ?? "")]),
        summary: {
          workflowRunId: run?.id != null ? String(run.id) : null,
          workflowName: typeof workflow?.name === "string" ? workflow.name : typeof run?.name === "string" ? run.name : null,
          headBranch: typeof run?.head_branch === "string" ? run.head_branch : null,
          sha: typeof run?.head_sha === "string" ? run.head_sha : null,
          conclusion,
          htmlUrl: typeof run?.html_url === "string" ? run.html_url : null,
          // treat only completed conclusions as terminal; status keep for storage
          deploymentStatus: status,
        },
        isFailure: conclusion === "failure" || conclusion === "startup_failure" || conclusion === "timed_out",
      };
    }
    case "check_run": {
      const run = payload.check_run as Record<string, unknown> | undefined;
      const conclusion = typeof run?.conclusion === "string" ? run.conclusion : null;
      const name = typeof run?.name === "string" ? run.name : null;
      return {
        ...base,
        fingerprint: fingerprint(event, fullName, [String(run?.id ?? action ?? ""), action ?? ""]),
        summary: {
          workflowName: name,
          conclusion,
          htmlUrl: typeof run?.html_url === "string" ? run.html_url : null,
        },
        isFailure: conclusion === "failure" || conclusion === "timed_out",
      };
    }
    case "deployment_status": {
      const state = typeof payload.state === "string" ? payload.state : null;
      const deployment = payload.deployment as Record<string, unknown> | undefined;
      return {
        ...base,
        fingerprint: fingerprint(event, fullName, [String((deployment?.id as number | undefined) ?? actor ?? ""), String(state ?? "")]),
        summary: {
          deploymentStatus: state,
          branch: typeof (deployment?.ref as string) === "string" ? (deployment?.ref as string) : null,
          environment: typeof (deployment?.environment as string) === "string" ? (deployment?.environment as string) : null,
          htmlUrl: typeof (payload.target_url as string) === "string" ? (payload.target_url as string) : null,
        },
        isFailure: state === "failure" || state === "error",
      };
    }
    case "installation": {
      // installation created / removed — repo access changes
      const installation = payload.installation as Record<string, unknown> | undefined;
      return {
        ...base,
        fingerprint: fingerprint(event, String(installation?.id ?? ""), [action ?? ""]),
        summary: { deploymentStatus: action },
        isFailure: false,
      };
    }
    default:
      return null; // events Orbit does not consume
  }
}

function fingerprint(event: string, repo: string, parts: string[]): string {
  return `${event}:${repo}:${parts.join("|")}`.slice(0, 80);
}
