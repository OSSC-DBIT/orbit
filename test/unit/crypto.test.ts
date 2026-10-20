import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  verifyHmacSha256,
  hmacSha256Signature,
  safeEquals,
  signJwtRs256,
  verifyJwtRs256,
} from "../../src/core/security/crypto.js";

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

describe("webhook HMAC verification", () => {
  const body = Buffer.from(JSON.stringify({ action: "opened", number: 1 }));
  const secret = "whsec_test_0123456789";

  it("accepts a valid sha256= signature", () => {
    expect(verifyHmacSha256(body, hmacSha256Signature(body, secret), secret)).toBe(true);
  });

  it("accepts the bare hex form too", () => {
    const bare = hmacSha256Signature(body, secret).replace("sha256=", "");
    expect(verifyHmacSha256(body, bare, secret)).toBe(true);
  });

  it("rejects a tampered payload and wrong secrets", () => {
    const sig = hmacSha256Signature(body, secret);
    expect(verifyHmacSha256(Buffer.from("{}"), sig, secret)).toBe(false);
    expect(verifyHmacSha256(body, sig, "other-secret")).toBe(false);
  });

  it("rejects missing, malformed and truncated headers", () => {
    expect(verifyHmacSha256(body, undefined, secret)).toBe(false);
    expect(verifyHmacSha256(body, "sha256=deadbeef", secret)).toBe(false);
    expect(verifyHmacSha256(body, "md5=" + "0".repeat(64), secret)).toBe(false);
    expect(verifyHmacSha256(body, "sha256=" + "z".repeat(64), secret)).toBe(false);
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

describe("RS256 JWT for GitHub App authentication", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  it("signs and verifies a round trip", () => {
    const jwt = signJwtRs256({ iss: "123456", iat: 1700000000, exp: 1700000300 }, privPem);
    const claims = verifyJwtRs256(jwt, pubPem);
    expect(claims?.iss).toBe("123456");
    expect(claims?.exp).toBe(1700000300);
  });

  it("rejects tampered tokens", () => {
    const jwt = signJwtRs256({ iss: "123456", iat: 1700000000, exp: 1700000300 }, privPem);
    const parts = jwt.split(".");
    const body = Buffer.from(JSON.stringify({ iss: "999", iat: 1700000000, exp: 1700000300 })).toString("base64url");
    expect(verifyJwtRs256([parts[0], body, parts[2]].join("."), pubPem)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifyJwtRs256("not-a-jwt", pubPem)).toBeNull();
  });
});
