/**
 * Secrets in the settings table are encrypted with AES-256-GCM under a key
 * derived from ADMIN_PASSWORD (scrypt), so the database alone doesn't reveal
 * them. Changing the password makes them unreadable until they are re-encrypted
 * with the old one (service.ts, rekeySecrets).
 *
 * Format: "v1.<iv>.<ciphertext>.<tag>", base64url.
 */
import crypto from "node:crypto";

const SALT = "serverless-agent-gateway/settings/v1";
const PREFIX = "v1";

/** scrypt takes ~100 ms on purpose; one key per password per instance. */
const keys = new Map<string, Buffer>();

function keyFor(password: string): Buffer {
  let key = keys.get(password);
  if (!key) {
    key = crypto.scryptSync(password, SALT, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    keys.clear();
    keys.set(password, key);
  }
  return key;
}

export class SecretKeyError extends Error {
  constructor() {
    super("can't decrypt: it was encrypted under another ADMIN_PASSWORD");
    this.name = "SecretKeyError";
  }
}

export function encryptSecret(plain: string, password: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(password), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv, data, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(token: string, password: string): string {
  const [prefix, iv, data, tag] = token.split(".");
  if (prefix !== PREFIX || !iv || data === undefined || !tag) throw new SecretKeyError();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(password), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError();
  }
}

/** How a secret is shown: enough to recognize it, not to use it. */
export function maskSecret(plain: string): string {
  return plain.length > 12 ? `${plain.slice(0, 6)}…${plain.slice(-4)}` : "••••••";
}
