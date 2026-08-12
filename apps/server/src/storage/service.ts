import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isCanonicalUuid } from "@paperclipai/shared";
import type { StorageService, StorageProvider, PutFileInput, PutFileResult } from "./types.js";
import { forbidden, unprocessable } from "../errors.js";
import { requireExactStorageObjectKey } from "./object-key.js";

const MAX_SEGMENT_LENGTH = 120;

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_SEGMENT_LENGTH);
}

function requireExactNamespace(namespace: string): string {
  if (
    namespace.length === 0
    || namespace !== namespace.trim()
    || namespace.startsWith("/")
    || namespace.endsWith("/")
    || namespace.includes("//")
  ) {
    throw unprocessable("namespace must be an exact non-empty path");
  }
  const segments = namespace.split("/");
  if (segments.some((segment) => {
    return segment === "."
      || segment === ".."
      || segment.length > MAX_SEGMENT_LENGTH
      || !/^[a-zA-Z0-9._-]+$/.test(segment);
  })) {
    throw unprocessable(
      "namespace segments may contain only letters, numbers, dot, underscore, and hyphen",
    );
  }
  return namespace;
}

function splitFilename(filename: string | null): { stem: string; ext: string } {
  if (!filename) return { stem: "file", ext: "" };
  const base = path.basename(filename).trim();
  if (!base) return { stem: "file", ext: "" };

  const extRaw = path.extname(base);
  const stemRaw = extRaw ? base.slice(0, base.length - extRaw.length) : base;
  const stem = sanitizeSegment(stemRaw);
  const ext = extRaw
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 16);
  return {
    stem,
    ext,
  };
}

function requireCompanyObjectKey(companyId: string, objectKey: string): string {
  const exactObjectKey = requireExactStorageObjectKey(objectKey);
  if (!isCanonicalUuid(companyId)) {
    throw unprocessable("companyId must be an exact canonical UUID");
  }
  if (exactObjectKey.split("/", 1)[0] !== companyId) {
    throw forbidden("Object does not belong to company");
  }
  return exactObjectKey;
}

function hashBuffer(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildObjectKey(companyId: string, namespace: string, originalFilename: string | null): string {
  const ns = requireExactNamespace(namespace);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const { stem, ext } = splitFilename(originalFilename);
  const suffix = randomUUID();
  const filename = `${suffix}-${stem}${ext}`;
  return `${companyId}/${ns}/${year}/${month}/${day}/${filename}`;
}

function assertPutFileInput(input: PutFileInput): void {
  if (!isCanonicalUuid(input.companyId)) {
    throw unprocessable("companyId must be an exact canonical UUID");
  }
  requireExactNamespace(input.namespace);
  if (
    input.contentType.length === 0
    || input.contentType !== input.contentType.trim()
    || input.contentType !== input.contentType.toLowerCase()
  ) {
    throw unprocessable("contentType must be exact, lowercase, and non-empty");
  }
  if (!(input.body instanceof Buffer)) {
    throw unprocessable("body must be a Buffer");
  }
  if (input.body.length <= 0) {
    throw unprocessable("File is empty");
  }
}

export function createStorageService(provider: StorageProvider): StorageService {
  return {
    provider: provider.id,

    async putFile(input: PutFileInput): Promise<PutFileResult> {
      assertPutFileInput(input);
      const objectKey = requireExactStorageObjectKey(
        buildObjectKey(input.companyId, input.namespace, input.originalFilename),
      );
      const byteSize = input.body.length;
      await provider.putObject({
        objectKey,
        body: input.body,
        contentType: input.contentType,
        contentLength: byteSize,
      });

      return {
        provider: provider.id,
        objectKey,
        contentType: input.contentType,
        byteSize,
        sha256: hashBuffer(input.body),
        originalFilename: input.originalFilename,
      };
    },

    async getObject(companyId: string, objectKey: string, options) {
      const exactObjectKey = requireCompanyObjectKey(companyId, objectKey);
      return provider.getObject({ objectKey: exactObjectKey, range: options?.range });
    },

    async headObject(companyId: string, objectKey: string) {
      const exactObjectKey = requireCompanyObjectKey(companyId, objectKey);
      return provider.headObject({ objectKey: exactObjectKey });
    },

    async deleteObject(companyId: string, objectKey: string) {
      const exactObjectKey = requireCompanyObjectKey(companyId, objectKey);
      await provider.deleteObject({ objectKey: exactObjectKey });
    },
  };
}
