import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyWebhook,
  normalizeGithubEvent,
  MAX_WEBHOOK_BYTES,
  type WebhookHeaders,
} from "../../src/projects/webhooks/verify.js";

const SECRET = "gh_webhook_secret_abcdef0123456789";

function sign(body: Buffer): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function headers(overrides: Partial<WebhookHeaders> = {}): WebhookHeaders {
  return {
    "x-github-event": "push",
    "x-github-delivery": "d-123",
    "x-hub-signature-256": sign,
    ...overrides,
  } as WebhookHeaders;
}

/** Utility so the signature always matches the current body. */
function withSignature(obj: WebhookHeaders, body: Buffer): WebhookHeaders {
  return { ...obj, "x-hub-signature-256": sign(body) };
}

describe("webhook verification", () => {
  it("accepts a properly signed delivery with raw-body HMAC", () => {
    const body = Buffer.from(JSON.stringify({ repository: { full_name: "o/r" } }));
    const r = verifyWebhook(body, withSignature(headers(), body), SECRET);
    expect(r).toMatchObject({ ok: true, code: "ok", deliveryId: "d-123", event: "push" });
  });

  it("rejects an invalid signature", () => {
    const body = Buffer.from("{}");
    const r = verifyWebhook(body, { ...headers(), "x-hub-signature-256": "sha256=" + "0".repeat(64) }, SECRET);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid-signature");
  });

  it("rejects a missing signature", () => {
    const { "x-hub-signature-256": _drop, ...rest } = headers();
    expect(verifyWebhook(Buffer.from("{}"), rest, SECRET).code).toBe("missing-signature");
  });

  it("fails closed when the webhook secret is not configured", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhook(body, withSignature(headers(), body), undefined).code).toBe("missing-secret");
  });

  it("rejects oversized payloads before signature work", () => {
    const body = Buffer.alloc(MAX_WEBHOOK_BYTES + 1, 8);
    const r = verifyWebhook(body, headers(), SECRET);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("too-large");
  });

  it("rejects deliveries without the GitHub headers", () => {
    expect(verifyWebhook(Buffer.from("{}"), {}, SECRET).code).toBe("missing-headers");
  });
});

describe("event normalization", () => {
  it("normalizes workflow_run failures for CI alerts", () => {
    const payload = {
      repository: { full_name: "orbit/repo" },
      sender: { login: "octocat" },
      installation: { id: 987654 },
      workflow_run: {
        id: 4242,
        run_number: 7,
        run_attempt: 1,
        name: "CI",
        conclusion: "failure",
        status: "completed",
        head_branch: "main",
        head_sha: "abc123",
        html_url: "https://github.com/orbit/repo/actions/runs/4242",
        updated_at: "2026-10-20T09:00:00Z",
      },
      workflow: { name: "CI pipeline" },
      action: "completed",
    };
    const e = normalizeGithubEvent("workflow_run", "d-1", payload as unknown as Record<string, unknown>);
    expect(e).not.toBeNull();
    expect(e!.repoFullName).toBe("orbit/repo");
    expect(e!.isFailure).toBe(true);
    expect(e!.summary.workflowName).toBe("CI pipeline");
    expect(e!.summary.workflowRunId).toBe("4242");
    expect(e!.summary.conclusion).toBe("failure");
    expect(e!.summary.headBranch).toBe("main");
    expect(e!.installationId).toBe("987654");
  });

  it("treats successful runs as activity, not alerts", () => {
    const payload = {
      repository: { full_name: "orbit/repo" },
      workflow_run: { id: 1, run_number: 2, run_attempt: 1, conclusion: "success", status: "completed" },
      workflow: { name: "CI" },
    };
    expect(normalizeGithubEvent("workflow_run", "d-2", payload as unknown as Record<string, unknown>)!.isFailure).toBe(false);
  });

  it("normalizes pushes with branch, sha and commit count", () => {
    const payload = {
      repository: { full_name: "orbit/repo" },
      sender: { login: "octocat" },
      ref: "refs/heads/feature/x",
      after: "cafe1234",
      compare: "https://github.com/orbit/repo/compare/cafe1234",
      commits: [{ id: "1" }, { id: "2" }],
      head_commit: { timestamp: "2026-10-20T10:00:00Z" },
    };
    const e = normalizeGithubEvent("push", "d-3", payload as unknown as Record<string, unknown>)!;
    expect(e.summary.branch).toBe("feature/x");
    expect(e.summary.sha).toBe("cafe1234");
    expect(e.summary.commitCount).toBe(2);
    expect(e.installationId).toBeNull(); // not app delivered
    expect(e.isFailure).toBe(false);
  });

  it("normalizes pull requests and issues", () => {
    const pr = normalizeGithubEvent("pull_request", "d-4", {
      repository: { full_name: "o/r" },
      action: "opened",
      pull_request: { number: 5, title: "Add feature", html_url: "https://github.com/o/r/pull/5" },
    } as unknown as Record<string, unknown>)!;
    expect(pr.summary.pullNumber).toBe(5);
    expect(pr.summary.conclusion).toBe("opened");

    const issue = normalizeGithubEvent("issues", "d-5", {
      repository: { full_name: "o/r" },
      action: "opened",
      issue: { number: 9, title: "Bug", html_url: "https://github.com/o/r/issues/9" },
    } as unknown as Record<string, unknown>)!;
    expect(issue.summary.issueNumber).toBe(9);
  });

  it("produces deterministic fingerprints (same delivery twice = same identity)", () => {
    const payload = {
      repository: { full_name: "o/r" },
      ref: "refs/heads/main",
      after: "sha1",
      commits: [{}, {}],
      head_commit: { timestamp: "2026-10-20T10:00:00Z" },
    };
    const a = normalizeGithubEvent("push", "d-6", payload as unknown as Record<string, unknown>);
    const b = normalizeGithubEvent("push", "d-6", payload as unknown as Record<string, unknown>);
    expect(a!.fingerprint).toBe(b!.fingerprint);

    const different = normalizeGithubEvent("push", "d-7", {
      ...payload,
      after: "sha2",
    } as unknown as Record<string, unknown>);
    expect(different!.fingerprint).not.toBe(a!.fingerprint);
  });

  it("returns null for payloads without a repository full name", () => {
    expect(normalizeGithubEvent("push", "d-8", {} as Record<string, unknown>)).toBeNull();
  });
});
