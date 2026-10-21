import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, safeEquals } from "../../src/core/security/crypto.js";

const KEY = Buffer.alloc(32, 7); // deterministic 32 byte test key

describe("secret encryption at rest", () => {
  it("round trips plaintext through AES-256-GCM", () => {
    const enc = encryptSecret("gh_install_token_value", KEY);
    expect(enc).not.toContain("gh_install_token_value");
    expect(decryptSecret(enc, KEY)).toBe("gh_install_token_value");
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("fails when the ciphertext is tampered with (auth tag mismatch)", () => {
    const enc = encryptSecret("secret", KEY);
    const payload = JSON.parse(enc) as { iv: string; tag: string; data: string };
    payload.data = Buffer.from("tampered bytes").toString("base64");
    expect(() => decryptSecret(JSON.stringify(payload), KEY)).toThrow();
  });

  it("rejects malformed or wrong-size keys", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16))).toThrow();
    expect(() => encryptSecret("x", "13")).toThrow();
  });
});

describe("constant time string equality", () => {
  it("matches identical strings and rejects different ones", () => {
    expect(safeEquals("abc123", "abc123")).toBe(true);
    expect(safeEquals("abc123", "abc124")).toBe(false);
  });

  it("never throws on differing lengths", () => {
    expect(safeEquals("short", "a-much-longer-value")).toBe(false);
  });
});
