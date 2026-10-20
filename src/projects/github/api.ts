import type { GitHubAppCredentials } from "./auth.js";

/**
 * Minimal GitHub REST client scoped to what the project monitoring features
 * need. Always repository-scoped by fullName; untrusted input is only ever
 * used in the path after a strict format validation.
 */

const VALID_REPO = /^[\w.-]+\/[\w.-]+$/;

export interface GithubRepoReference {
  fullName: string;
}

export class GitHubApi {
  constructor(
    private getInstallationId: (repoFullName: string) => Promise<string | null>,
    private getToken: (installationId: string) => Promise<string | null>,
    private credentials: GitHubAppCredentials | null,
  ) {}

  static forCredentials(
    credentials: GitHubAppCredentials | null,
    dbResolver?: (repoFullName: string) => Promise<string | null>,
  ): GitHubApi {
    const fallbackResolver = async (): Promise<string | null> => null;
    const tokenFor = async (installationId: string): Promise<string | null> => {
      if (!credentials) return null;
      const { TokenStore } = await import("./token-store.js");
      const { getDb } = await import("../../database/client.js");
      const store = new TokenStore(getDb());
      return store.tokenFor(installationId, credentials);
    };
    void fallbackResolver;
    return new GitHubApi(dbResolver ?? fallbackResolver, tokenFor, credentials);
  }

  private async request<T>(
    repoParts: string,
    pathSuffix: string,
  ): Promise<T | null> {
    if (!VALID_REPO.test(repoParts)) return null;
    const installationId = await this.getInstallationId(repoParts);
    if (!installationId) return null;
    const token = await this.getToken(installationId);
    if (!token) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`https://api.github.com/repos/${repoParts}/${pathSuffix}`, {
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async listWorkflowJobs(repoFullName: string, runId: string): Promise<WorkflowJob[] | null> {
    const json = await this.request<{ jobs?: WorkflowJob[] }>(repoFullName, `actions/runs/${encodeURIComponent(runId)}/jobs?per_page=20`);
    return json?.jobs ?? null;
  }

  async fetchJobLog(repoFullName: string, jobId: string): Promise<string | null> {
    if (!VALID_REPO.test(repoFullName)) return null;
    const installationId = await this.getInstallationId(repoFullName);
    if (!installationId) return null;
    const token = await this.getToken(installationId);
    if (!token) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(
          `https://api.github.com/repos/${repoFullName}/actions/jobs/${encodeURIComponent(jobId)}/logs`,
          { signal: controller.signal, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
        );
        if (!response.ok) return null;
        return await response.text();
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  async getRun(repoFullName: string, runId: string): Promise<WorkflowRunInfo | null> {
    return this.request<WorkflowRunInfo>(repoFullName, `actions/runs/${encodeURIComponent(runId)}`);
  }
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  steps?: Array<{ name: string; conclusion: string | null; number: number }>;
}

export interface WorkflowRunInfo {
  id: number;
  name?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  event?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  actor?: { login?: string } | null;
}
