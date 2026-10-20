import { signJwtRs256 } from "../../core/security/crypto.js";
import type { Environment } from "../../core/config/env.js";

/**
 * GitHub App authentication.
 *
 * Preferred integration: a GitHub App installed on the repositories a guild
 * wants monitored, with narrow permissions ("Repository: metadata read",
 * "Actions: read", "Pull requests: read", "Issues: read",
 * "Contents: read" only when log fetching is enabled).
 *
 * Short lived installation access tokens are minted per request batch and
 * optionally encrypted at rest using APP_ENCRYPTION_KEY.
 */

const JWT_TTL_SECONDS = 9 * 60; // GitHub requires <= 10 minutes

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export function loadGitHubAppCredentials(env: Partial<Environment>): GitHubAppCredentials | null {
  const appId = env.GITHUB_APP_ID;
  let pem = env.GITHUB_APP_PRIVATE_KEY ?? null;
  if (!pem && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      pem = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    } catch {
      pem = null;
    }
  }
  if (!appId || !pem) return null;
  return { appId, privateKeyPem: pem.replace(/\\n/g, "\n") };
}

export function appJwt(credentials: GitHubAppCredentials): string {
  const now = Math.floor(Date.now() / 1000) - 60; // clock drift guard
  return signJwtRs256(
    { iss: credentials.appId, iat: now, exp: now + JWT_TTL_SECONDS },
    credentials.privateKeyPem,
  );
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
}

/** Mints an installation access token for a GitHub App installation id. */
export async function createInstallationToken(
  credentials: GitHubAppCredentials,
  installationId: string,
): Promise<InstallationToken | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${appJwt(credentials)}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        body: "{}",
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;
    const json = (await response.json()) as InstallationTokenResponse;
    if (!json.token) return null;
    return {
      token: json.token,
      expiresAt: new Date(json.expires_at),
      permissions: json.permissions ?? {},
    };
  } catch {
    return null; // fail closed; callers proceed without logs/diagnostics
  }
}
