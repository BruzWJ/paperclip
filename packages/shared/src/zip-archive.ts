import type { CompanyPortabilityFileEntry } from "./types/company-portability.js";

// Zip central-directory parser shared by the browser importer (apps/ui) and the
// CLI importer (packages/cli). Inflation is environment-specific, so callers
// supply an `inflateRaw` implementation (DecompressionStream in the browser,
// node:zlib inflateRawSync in the CLI).

const textDecoder = new TextDecoder();

/** Raw-deflate decompressor supplied by the runtime environment. */
export type ZipInflateRaw = (
  compressed: Uint8Array,
) => Uint8Array | Promise<Uint8Array>;

export const binaryContentTypeByExtension: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function normalizeArchivePath(pathValue: string) {
  return pathValue
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function readUint16(source: Uint8Array, offset: number) {
  return source[offset]! | (source[offset + 1]! << 8);
}

function readUint32(source: Uint8Array, offset: number) {
  return (
    source[offset]! |
    (source[offset + 1]! << 8) |
    (source[offset + 2]! << 16) |
    (source[offset + 3]! << 24)
  ) >>> 0;
}

function sharedArchiveRoot(paths: string[]) {
  if (paths.length === 0) return null;
  const firstSegments = paths
    .map((entry) => normalizeArchivePath(entry).split("/").filter(Boolean))
    .filter((parts) => parts.length > 0);
  if (firstSegments.length === 0) return null;
  const candidate = firstSegments[0]![0]!;
  return firstSegments.every((parts) => parts.length > 1 && parts[0] === candidate)
    ? candidate
    : null;
}

function inferBinaryContentType(pathValue: string) {
  const normalized = normalizeArchivePath(pathValue);
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex === -1) return null;
  return binaryContentTypeByExtension[normalized.slice(extensionIndex).toLowerCase()] ?? null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToPortableFileEntry(pathValue: string, bytes: Uint8Array): CompanyPortabilityFileEntry {
  const contentType = inferBinaryContentType(pathValue);
  if (!contentType) return textDecoder.decode(bytes);
  return {
    encoding: "base64",
    data: bytesToBase64(bytes),
    contentType,
  };
}

async function inflateZipEntry(inflateRaw: ZipInflateRaw, compressionMethod: number, bytes: Uint8Array) {
  if (compressionMethod === 0) return bytes;
  if (compressionMethod !== 8) {
    throw new Error("Unsupported zip archive: only STORE and DEFLATE entries are supported.");
  }
  return inflateRaw(bytes);
}

export async function readZipArchive(
  source: ArrayBuffer | Uint8Array,
  inflateRaw: ZipInflateRaw,
): Promise<{
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const entries: Array<{ path: string; body: CompanyPortabilityFileEntry }> = [];
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const signature = readUint32(bytes, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      throw new Error("Invalid zip archive: unsupported local file header.");
    }

    if (offset + 30 > bytes.length) {
      throw new Error("Invalid zip archive: truncated local file header.");
    }

    const generalPurposeFlag = readUint16(bytes, offset + 6);
    const compressionMethod = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const fileNameLength = readUint16(bytes, offset + 26);
    const extraFieldLength = readUint16(bytes, offset + 28);

    if ((generalPurposeFlag & 0x0008) !== 0) {
      throw new Error("Unsupported zip archive: data descriptors are not supported.");
    }

    const nameOffset = offset + 30;
    const bodyOffset = nameOffset + fileNameLength + extraFieldLength;
    const bodyEnd = bodyOffset + compressedSize;
    if (bodyEnd > bytes.length) {
      throw new Error("Invalid zip archive: truncated file contents.");
    }

    const rawArchivePath = textDecoder.decode(bytes.slice(nameOffset, nameOffset + fileNameLength));
    const archivePath = normalizeArchivePath(rawArchivePath);
    const isDirectoryEntry = /\/$/.test(rawArchivePath.replace(/\\/g, "/"));
    if (archivePath && !isDirectoryEntry) {
      const entryBytes = await inflateZipEntry(inflateRaw, compressionMethod, bytes.slice(bodyOffset, bodyEnd));
      entries.push({
        path: archivePath,
        body: bytesToPortableFileEntry(archivePath, entryBytes),
      });
    }

    offset = bodyEnd;
  }

  const rootPath = sharedArchiveRoot(entries.map((entry) => entry.path));
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  for (const entry of entries) {
    const normalizedPath =
      rootPath && entry.path.startsWith(`${rootPath}/`)
        ? entry.path.slice(rootPath.length + 1)
        : entry.path;
    if (!normalizedPath) continue;
    files[normalizedPath] = entry.body;
  }

  return { rootPath, files };
}
