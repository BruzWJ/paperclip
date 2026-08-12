const MAX_OBJECT_KEY_LENGTH = 1_024;
const MAX_OBJECT_KEY_SEGMENT_LENGTH = 200;
const OBJECT_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isExactStorageObjectKey(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_OBJECT_KEY_LENGTH ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\")
  ) {
    return false;
  }

  return value
    .split("/")
    .every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        segment.length <= MAX_OBJECT_KEY_SEGMENT_LENGTH &&
        OBJECT_KEY_SEGMENT_PATTERN.test(segment),
    );
}

export function parseExactStoragePrefix(value: string): string {
  if (value !== "" && !isExactStorageObjectKey(value)) {
    throw new Error(
      "Storage prefix must be empty or one exact slash-separated object-key path",
    );
  }
  return value;
}

export function parseExactStorageEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Storage endpoint must be one exact HTTP(S) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error("Storage endpoint must be one exact HTTP(S) origin");
  }
  return value;
}

export function parseExactStorageName(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be exact and non-empty`);
  }
  return value;
}
