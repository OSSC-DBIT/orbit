import { createInstallationToken, type GitHubAppCredentials } from "./auth.js";
import type { Database } from "../../database/client.js";
import { getDb } from "../../database/client.js";
import { eq } from "drizzle-orm";
import { githubInstallations } from "../../database/schema/index.js";
import { decryptSecret, encryptSecret } from "../../core/security/crypto.js";
import { loadConfig } from "../../core/config/env.js";

/**
 * Token acquisition with DB caching. Tokens are encrypted at rest when
 * APP_ENCRYPTION_KEY is configured; otherwise they are only held in memory.
 */
export class TokenStore {
  constructor(private db: Database = getDb()) {}

  async tokenFor(installationId: string, credentials: GitHubAppCredentials): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    const row = rows[0];
    const now = Date.now();
    if (row?.accessTokenEnc && row.accessTokenExpiresAt) {
      if (row.accessTokenExpiresAt.getTime() > now + 5 * 60 * 1000) {
        const key = this.encryptionKey();
        if (key) {
          try {
            return decryptSecret(row.accessTokenEnc, key);
          } catch {
            // fall through to minting a fresh token
          }
        }
      }
    }

    const minted = await createInstallationToken(credentials, installationId);
    if (!minted) return null;

    const key = this.encryptionKey();
    await this.db
      .insert(githubInstallations)
      .values({
        installationId,
        accountLogin: row?.accountLogin ?? "unknown",
        accessTokenEnc: key ? encryptSecret(minted.token, key) : null,
        accessTokenExpiresAt: minted.expiresAt,
        permissions: minted.permissions,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accessTokenEnc: key ? encryptSecret(minted.token, key) : null,
          accessTokenExpiresAt: minted.expiresAt,
          permissions: minted.permissions,
          updatedAt: new Date(),
        },
      });
    return minted.token;
  }

  private encryptionKey(): Buffer | null {
    try {
      const config = loadConfig();
      return config.encryptionKey ?? null;
    } catch {
      return null;
    }
  }
}

export function installationIdFromPayload(repository: Record<string, unknown>): string | null {
  const installation = repository.installation as Record<string, unknown> | null;
  const id = installation?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}
