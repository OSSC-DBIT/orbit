/**
 * Tenant authorization policy.
 *
 * Pure logic — no Discord imports — so it is fully unit-testable. The Discord
 * interaction adapter (bot/middleware.ts) extracts the facts and calls
 * `evaluateAdminAuthorization`.
 *
 * Rules:
 *  1. Authentication: the acting user must be a member of the SAME guild they
 *     target (interaction context provides this; a mismatched guild is a bug
 *     and is denied).
 *  2. Authorization: user must be a Discord guild administrator OR be listed
 *     in `guild_authorized_roles` (roles OR direct user ID) for THAT guild.
 *  3. Everything is scoped to one guild; principals authorized in guild A
 *     never satisfy checks for guild B.
 */

export interface AdminCheckInput {
  /** Guild the interaction occurred in. */
  guildId: string | null;
  /** Acting Discord user ID (from the verified interaction context). */
  userId: string | null;
  /** Raw bigint permission bits as a string (discord.js). */
  memberPermissionBits: string | null;
  /** Role IDs of the acting member. */
  memberRoleIds: string[];
  /** Authorization rows persisted for the target guild. */
  guildAuthorizedRoleIds: string[];
}

export interface AdminCheckResult {
  allowed: boolean;
  reason:
    | "missing-guild"
    | "missing-user"
    | "not-guild-admin"
    | "not-authorized"
    | "allowed-guild-admin"
    | "allowed-listed-principal";
}

/** discord.js PermissionsBitField.Flags.Administrator = 1n << 3n */
const ADMINISTRATOR_BIT = 1n << 3n;
/** ManageGuild = 1n << 5n (secondary admin signal). */
const MANAGE_GUILD_BIT = 1n << 5n;

export function evaluateAdminAuthorization(input: AdminCheckInput): AdminCheckResult {
  if (!input.guildId) return { allowed: false, reason: "missing-guild" };
  if (!input.userId) return { allowed: false, reason: "missing-user" };

  const bits = BigInt(input.memberPermissionBits && input.memberPermissionBits !== "0" ? input.memberPermissionBits : "0");
  if ((bits & ADMINISTRATOR_BIT) !== 0n) {
    return { allowed: true, reason: "allowed-guild-admin" };
  }
  const listed = new Set(input.guildAuthorizedRoleIds);
  if (
    (bits & MANAGE_GUILD_BIT) !== 0n ||
    listed.has(input.userId) ||
    input.memberRoleIds.some((r) => listed.has(r))
  ) {
    return { allowed: true, reason: "allowed-listed-principal" };
  }
  if ((bits & ADMINISTRATOR_BIT) === 0n) {
    return { allowed: false, reason: "not-guild-admin" };
  }
  return { allowed: false, reason: "not-authorized" };
}

/** Users may run non-admin commands if they exist in a guild context at all. */
export function evaluateMemberPresence(input: { guildId: string | null; userId: string | null }): {
  allowed: boolean;
  reason: "ok" | "missing-guild" | "missing-user";
} {
  if (!input.guildId) return { allowed: false, reason: "missing-guild" };
  if (!input.userId) return { allowed: false, reason: "missing-user" };
  return { allowed: true, reason: "ok" };
}
