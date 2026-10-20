import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createSign,
  createVerify,
} from "node:crypto";
import { REDACTED } from "./redact.js";

/** Cryptographic helpers — no plaintext secrets are ever persisted. */

function keyToBuffer(keyHexOrRaw: string | Buffer): Buffer {
  if (Buffer.isBuffer(keyHexOrRaw)) return keyHexOrRaw;
  const cleaned = keyHexOrRaw.replace(/\s+/g, "");
  const asB64 = Buffer.from(cleaned, "base64");
  if (asB64.length === 32) return asB64;
  const asHex = Buffer.from(cleaned, "hex");
  if (asHex.length === 32) return asHex;
  throw new Error("encryption key must be 32 bytes (base64 or hex)");
}

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM. Returns self-contained JSON string safe for DB storage. */
export function encryptSecret(
  plaintext: string,
  key: string | Buffer,
): string {
  if (!plaintext) throw new Error("cannot encrypt an empty secret");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyToBuffer(key), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
  return JSON.stringify(payload);
}

export function decryptSecret(encrypted: string, key: string | Buffer): string {
  const payload = JSON.parse(encrypted) as EncryptedPayload;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyToBuffer(key),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Verifies `X-Hub-Signature-256: sha256=<hex>` style signatures (GitHub webhooks). */
export function verifyHmacSha256(
  payload: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  const provided = signatureHeader.trim();
  const match = /^(?:sha256=)?([a-f0-9]{64})$/i.exec(provided);
  const hex = match?.[1];
  if (!hex) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(hex.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Returns the HMAC signature in GitHub's wire format (for tests). */
export function hmacSha256Signature(payload: Buffer | string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

const REDACTED_SECRET = REDACTED;

/** Constant-time string equality (both inputs hex/base64 safe). */
export function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still burn comparable time to reduce length-based side channels.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** RS256 JWT signing used for GitHub App installation tokens. */
export function signJwtRs256(
  payload: { iss: string; iat: number; exp: number },
  privatePem: string,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = signer.sign(privatePem.replace(/\\n/g, "\n"), "base64url");
  return `${header}.${body}.${signature}`;
}

/** Verify helper (used in tests for round-trip validation). */
export function verifyJwtRs256(jwt: string, publicPem: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${b}`);
  if (!verifier.verify(publicPem, Buffer.from(s, "base64url"))) return null;
  try {
    return JSON.parse(Buffer.from(b, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function newId(): string {
  return randomUUID();
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

// The placeholder below preserves the redaction import in builds where only
// encryption helpers are used, without triggering unused warnings.
export const REDACTED_PLACEHOLDER = REDACTED_SECRET;
