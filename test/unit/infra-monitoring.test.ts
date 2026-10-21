import { describe, expect, it } from "vitest";
import { isHostStale, resolveSeverity, severityColor, tokenHash } from "../../src/monitoring/infra.js";

/**
 * Offline unit coverage for project monitoring (push API) pure helpers:
 * severity normalization, token hashing, watchdog stale rule, embed palette.
 */

const NOW = new Date("2026-10-21T12:00:00.000Z");

function host(
  overrides: {
    status?: string;
    lastHeartbeatAt?: Date | null;
    createdAt?: Date;
    slaMinutes?: number;
  } = {},
) {
  return {
    status: overrides.status ?? "active",
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 10 * 60_000),
    slaMinutes: overrides.slaMinutes ?? 60,
  };
}

describe("resolveSeverity", () => {
  it("accepts the canonical severities", () => {
    expect(resolveSeverity("ok")).toBe("ok");
    expect(resolveSeverity("info")).toBe("info");
    expect(resolveSeverity("warn")).toBe("warn");
    expect(resolveSeverity("error")).toBe("error");
  });

  it("degrades unknown values to info instead of throwing", () => {
    expect(resolveSeverity(undefined)).toBe("info");
    expect(resolveSeverity(null)).toBe("info");
    expect(resolveSeverity("fatal")).toBe("info");
    expect(resolveSeverity(42)).toBe("info");
  });
});

describe("tokenHash", () => {
  it("produces the sha256 hex of the utf8 token", () => {
    // Classic sha256 test vector for "abc".
    expect(tokenHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and discriminates tokens", () => {
    expect(tokenHash("orb-token-one")).toBe(tokenHash("orb-token-one"));
    expect(tokenHash("orb-token-one")).not.toBe(tokenHash("orb-token-two"));
  });

  it("is a 64 character lowercase hex digest", () => {
    const digest = tokenHash("something");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isHostStale", () => {
  it("freshly created project without heartbeats is not stale yet", () => {
    expect(isHostStale(host({ createdAt: new Date(NOW.getTime() - 10 * 60_000) }), NOW)).toBe(false);
  });

  it("project past its sla budget is stale", () => {
    expect(isHostStale({ ...host(), slaMinutes: 60, createdAt: new Date(NOW.getTime() - 70 * 60_000) }, NOW)).toBe(true);
  });

  it("counts silence from the last heartbeat", () => {
    expect(
      isHostStale(host({ lastHeartbeatAt: new Date(NOW.getTime() - 70 * 60_000), createdAt: new Date(NOW.getTime() - 400 * 60_000) }), NOW),
    ).toBe(true);
    expect(
      isHostStale(host({ lastHeartbeatAt: new Date(NOW.getTime() - 59 * 60_000), createdAt: new Date(NOW.getTime() - 400 * 60_000) }), NOW),
    ).toBe(false);
  });

  it("already stale projects never re flag (one alert per stale period)", () => {
    expect(
      isHostStale(
        host({ status: "stale", lastHeartbeatAt: new Date(NOW.getTime() - 999 * 60_000) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("honours custom sla budgets", () => {
    expect(isHostStale(host({ lastHeartbeatAt: new Date(NOW.getTime() - 20 * 60_000), slaMinutes: 15 }), NOW)).toBe(true);
    expect(isHostStale(host({ lastHeartbeatAt: new Date(NOW.getTime() - 20 * 60_000), slaMinutes: 45 }), NOW)).toBe(false);
  });
});

describe("severityColor", () => {
  it("maps severities to distinct embed colors", () => {
    const colors = new Set([
      severityColor("ok"),
      severityColor("info"),
      severityColor("warn"),
      severityColor("error"),
    ]);
    expect(colors.size).toBe(4);
    expect(severityColor("ok")).toBe(0x57f287);
    expect(severityColor("error")).toBe(0xed4245);
  });
});
