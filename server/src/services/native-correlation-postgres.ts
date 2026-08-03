import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  NativeCorrelationRejected,
  validateAcpCorrelationScope,
  type AcpCorrelationScope,
  type AcpSessionCorrelationProtector,
  type ProtectedAcpSessionCorrelation,
} from "./native-correlation.js";

const CIPHERTEXT_PREFIX = "pcnc.v1";
const CIPHER_AAD = Buffer.from(
  "paperclip.issue-execution-native-correlation/v1",
  "utf8",
);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => Object.getOwnPropertyDescriptor(value, key)?.value !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          Object.getOwnPropertyDescriptor(value, key)?.value,
        )}`,
    )
    .join(",")}}`;
}

function secretBytes(secret: string | Uint8Array): Buffer {
  const value =
    typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (value.byteLength < 32) {
    throw new Error(
      "Native-correlation protection secret must contain at least 32 bytes",
    );
  }
  return value;
}

function derivedKey(
  secret: Buffer,
  purpose: "encryption" | "digest",
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.from("paperclip-native-correlation", "utf8"),
      Buffer.from(purpose, "utf8"),
      32,
    ),
  );
}

function scopeAad(scope: AcpCorrelationScope): Buffer {
  validateAcpCorrelationScope(scope);
  return Buffer.concat([
    CIPHER_AAD,
    Buffer.from("\0", "utf8"),
    Buffer.from(canonicalJson(scope), "utf8"),
  ]);
}

function digestBytes(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new NativeCorrelationRejected(
      "Stored native correlation digest is malformed",
    );
  }
  return Buffer.from(value, "hex");
}

/**
 * Authenticated encryption for the fixed ACP correlation envelope stored in
 * PostgreSQL. This module deliberately has no correlation repository or
 * adapter codec registry: installation/supersession is part of the prompt's
 * atomic run/capability transition.
 */
export function createAuthenticatedNativeCorrelationProtector(options: {
  readonly secret: string | Uint8Array;
  readonly random?: (size: number) => Buffer;
}): AcpSessionCorrelationProtector {
  const secret = secretBytes(options.secret);
  const encryptionKey = derivedKey(secret, "encryption");
  const digestKey = derivedKey(secret, "digest");
  const random = options.random ?? randomBytes;

  const plaintextDigest = (plaintext: Buffer) =>
    createHmac("sha256", digestKey).update(plaintext).digest();

  return {
    async seal(correlation, scope): Promise<ProtectedAcpSessionCorrelation> {
      const plaintext = Buffer.from(canonicalJson(correlation), "utf8");
      const nonce = random(12);
      if (nonce.byteLength !== 12) {
        throw new Error(
          "Native-correlation nonce source must return exactly 12 bytes",
        );
      }
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(scopeAad(scope));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
        codecKind: ACP_SESSION_CORRELATION_KIND,
        ciphertext: [
          CIPHERTEXT_PREFIX,
          nonce.toString("base64url"),
          tag.toString("base64url"),
          ciphertext.toString("base64url"),
        ].join("."),
        digest: plaintextDigest(plaintext).toString("hex"),
      };
    },

    async open(protectedCorrelation, scope): Promise<unknown> {
      try {
        if (
          protectedCorrelation.envelopeVersion !==
            ACP_SESSION_CORRELATION_ENVELOPE_VERSION ||
          protectedCorrelation.codecKind !== ACP_SESSION_CORRELATION_KIND
        ) {
          throw new Error("invalid envelope contract");
        }
        const parts = protectedCorrelation.ciphertext.split(".");
        if (parts.length !== 5 || `${parts[0]}.${parts[1]}` !== CIPHERTEXT_PREFIX) {
          throw new Error("invalid ciphertext version");
        }
        const nonce = Buffer.from(parts[2]!, "base64url");
        const tag = Buffer.from(parts[3]!, "base64url");
        const ciphertext = Buffer.from(parts[4]!, "base64url");
        if (
          nonce.byteLength !== 12 ||
          tag.byteLength !== 16 ||
          ciphertext.byteLength === 0
        ) {
          throw new Error("invalid ciphertext shape");
        }
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
        decipher.setAAD(scopeAad(scope));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        const actualDigest = plaintextDigest(plaintext);
        const expectedDigest = digestBytes(protectedCorrelation.digest);
        if (!timingSafeEqual(actualDigest, expectedDigest)) {
          throw new Error("correlation digest mismatch");
        }
        return JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new NativeCorrelationRejected(
          "Stored native correlation could not be authenticated",
        );
      }
    },
  };
}

export type PostgresNativeCorrelationProtector = ReturnType<
  typeof createAuthenticatedNativeCorrelationProtector
>;
