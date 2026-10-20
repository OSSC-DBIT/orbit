import { describe, expect, it } from "vitest";
import { redactString, redactDeep, REDACTED } from "../../src/core/security/redact.js";

describe("free text redaction", () => {
  it("redacts GitHub personal access tokens", () => {
    expect(redactString("token ghp_" + "a".repeat(36) + " in log")).not.toContain("a".repeat(36));
    expect(redactString("ghp_" + "a".repeat(36))).toBe(REDACTED);
  });

  it("redacts fine grained GitHub tokens", () => {
    const tok = "github_pat_" + "B".repeat(40);
    expect(redactString(`error near ${tok}`)).toBe(`error near ${REDACTED}`);
  });

  it("redacts JWTs, groq keys, aws keys, bearer headers", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9." + "p".repeat(12) + "." + "s".repeat(12);
    expect(redactString(`auth ${jwt}!`)).not.toContain("p".repeat(12));
    expect(redactString("key gsk_" + "k".repeat(24))).not.toContain("k".repeat(24));
    expect(redactString("id AKIA1234567890ABCDEF")).not.toContain("AKIA1234567890ABCDEF");
    expect(redactString("Authorization: Bearer abcdef0123456789abcdef")).not.toContain("abcdef0123456789abcdef");
  });

  it("redacts password style assignments", () => {
    expect(redactString("password: hunter2")).toBe(`password:${REDACTED}`);
  });

  it("redacts credentials embedded in URLs", () => {
    const out = redactString("postgresql://orbit:supersecret@localhost:5432/orbit");
    expect(out).toBe(`postgresql://orbit:${REDACTED}@localhost:5432/orbit`);
  });

  it("leaves ordinary log text untouched", () => {
    expect(redactString("synced 45 hackathons from 6 sources")).toBe("synced 45 hackathons from 6 sources");
  });
});

describe("structured redaction", () => {
  it("redacts sensitive keys anywhere in the tree", () => {
    const out = redactDeep({
      token: "shhh",
      nested: { apiKey: "abc", plain: "visible" },
      list: [{ password: "pw" }, 42, "ok"],
    }) as Record<string, unknown>;
    expect(out.token).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).plain).toBe("visible");
    expect((out.list as unknown[])[0]).toEqual({ password: REDACTED });
    expect((out.list as unknown[])[2]).toBe("ok");
  });

  it("is cycle safe", () => {
    const obj: Record<string, unknown> = { name: "safe" };
    obj.self = obj;
    expect(() => redactDeep(obj)).not.toThrow();
    expect((redactDeep(obj) as Record<string, unknown>).name).toBe("safe");
  });

  it("redacts leaked secrets inside plain string values too", () => {
    const out = redactDeep({ message: "failed with ghp_" + "c".repeat(36) }) as Record<string, unknown>;
    expect(out.message).toBe("failed with " + REDACTED);
  });
});
