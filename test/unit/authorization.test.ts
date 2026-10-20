import { describe, expect, it } from "vitest";
import { evaluateAdminAuthorization } from "../../src/tenants/policies/authorization.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const USER = "333333333333333333";
const OTHER = "444444444444444444";

function base(overrides: Partial<Parameters<typeof evaluateAdminAuthorization>[0]> = {}) {
  return {
    guildId: GUILD_A,
    userId: USER,
    memberPermissionBits: "0",
    memberRoleIds: [] as string[],
    guildAuthorizedRoleIds: [] as string[],
    ...overrides,
  };
}

describe("tenant authorization policy", () => {
  it("denies when there is no guild or user context", () => {
    expect(evaluateAdminAuthorization(base({ guildId: null })).reason).toBe("missing-guild");
    expect(evaluateAdminAuthorization(base({ userId: null })).reason).toBe("missing-user");
  });

  it("allows Discord administrators (Administrator bit)", () => {
    // Administrator = 1n << 3n = 8
    const r = evaluateAdminAuthorization(base({ memberPermissionBits: "8" }));
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("allowed-guild-admin");
  });

  it("allows Manage Guild holders and listed principals", () => {
    // ManageGuild = 1n << 5n = 32
    expect(evaluateAdminAuthorization(base({ memberPermissionBits: "32" })).allowed).toBe(true);
    expect(evaluateAdminAuthorization(base({ guildAuthorizedRoleIds: [USER] })).reason).toBe("allowed-listed-principal");
    expect(evaluateAdminAuthorization(base({ memberRoleIds: ["555", "777"], guildAuthorizedRoleIds: ["777"] })).allowed).toBe(true);
  });

  it("denies unprivileged members with a precise reason", () => {
    // VIEW_CHANNEL | ADD_REACTIONS | SEND_MESSAGES | MANAGE_MESSAGES, no admin
    const r = evaluateAdminAuthorization(base({ memberPermissionBits: "11328" }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("not-guild-admin");
  });

  it("scopes authorization rows to a single guild: a principal allowed in guild A is not allowed in guild B", () => {
    const inGuildA = evaluateAdminAuthorization(base({ guildId: GUILD_A, guildAuthorizedRoleIds: [USER] }));
    expect(inGuildA.allowed).toBe(true);
    // Guild B has its own (empty) authorization rows: same user must be denied.
    const inGuildB = evaluateAdminAuthorization(base({ guildId: GUILD_B, guildAuthorizedRoleIds: [] }));
    expect(inGuildB.allowed).toBe(false);
    expect(inGuildB.reason).toBe("not-guild-admin");
  });

  it("never carries role memberships across guilds even when role IDs collide", () => {
    // Discord role IDs are global, but each guild's authorized list is checked
    // against its own rows only; an unrelated guild listing another principal
    // must not elevate this member.
    const r = evaluateAdminAuthorization(
      base({ guildId: GUILD_B, memberRoleIds: ["555"], guildAuthorizedRoleIds: [OTHER] }),
    );
    expect(r.allowed).toBe(false);
  });
});
