import { inflateRawSync } from "node:zlib";
import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";
import {
  binaryContentTypeByExtension,
  readZipArchive as readZipArchiveWith,
} from "@paperclipai/shared/zip-archive";

export { binaryContentTypeByExtension };

function inflateRaw(bytes: Uint8Array) {
  return new Uint8Array(inflateRawSync(bytes));
}

export async function readZipArchive(source: ArrayBuffer | Uint8Array): Promise<{
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  return readZipArchiveWith(source, inflateRaw);
}
