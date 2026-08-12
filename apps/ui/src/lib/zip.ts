import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";
import {
  requireArchivePath,
  readZipArchive as readZipArchiveWith,
} from "@paperclipai/shared/zip-archive";

const textEncoder = new TextEncoder();

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crcTable[i] = crc >>> 0;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function getDosDateTime(date: Date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function concatChunks(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function portableFileEntryToBytes(
  entry: CompanyPortabilityFileEntry,
): Uint8Array {
  if (typeof entry === "string") return textEncoder.encode(entry);
  return base64ToBytes(entry.data);
}

async function inflateRaw(bytes: Uint8Array) {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "Unsupported zip archive: this browser cannot read compressed zip entries.",
    );
  }
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const stream = new Blob([body])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipArchive(
  source: ArrayBuffer | Uint8Array,
): Promise<{
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  return readZipArchiveWith(source, inflateRaw);
}

export function createZipArchive(
  files: Record<string, CompanyPortabilityFileEntry>,
  rootPath: string,
): Uint8Array {
  const exactRoot = requireArchivePath(rootPath);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  const archiveDate = getDosDateTime(new Date());
  let localOffset = 0;
  let entryCount = 0;

  for (const [relativePath, contents] of Object.entries(files).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    requireArchivePath(relativePath);
    const archivePath = requireArchivePath(`${exactRoot}/${relativePath}`);
    const fileName = textEncoder.encode(archivePath);
    const body = portableFileEntryToBytes(contents);
    const checksum = crc32(body);

    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, archiveDate.time);
    writeUint16(localHeader, 12, archiveDate.date);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, body.length);
    writeUint32(localHeader, 22, body.length);
    writeUint16(localHeader, 26, fileName.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, archiveDate.time);
    writeUint16(centralHeader, 14, archiveDate.date);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, body.length);
    writeUint32(centralHeader, 24, body.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
    entryCount += 1;
  }

  const centralDirectory = concatChunks(centralChunks);
  const endOfCentralDirectory = new Uint8Array(22);
  writeUint32(endOfCentralDirectory, 0, 0x06054b50);
  writeUint16(endOfCentralDirectory, 4, 0);
  writeUint16(endOfCentralDirectory, 6, 0);
  writeUint16(endOfCentralDirectory, 8, entryCount);
  writeUint16(endOfCentralDirectory, 10, entryCount);
  writeUint32(endOfCentralDirectory, 12, centralDirectory.length);
  writeUint32(endOfCentralDirectory, 16, localOffset);
  writeUint16(endOfCentralDirectory, 20, 0);

  return concatChunks([
    ...localChunks,
    centralDirectory,
    endOfCentralDirectory,
  ]);
}
