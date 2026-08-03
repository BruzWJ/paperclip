export function normalizePublicOrigin(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) {
    throw new Error("Public origin must not be empty");
  }
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("Public origin must be a valid HTTPS URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Public origin must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Public origin must use https://");
  }

  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator < 0) {
    throw new Error("Public origin must be a valid HTTPS URL");
  }
  const authorityAndSuffix = value.slice(schemeSeparator + 3);
  const suffixIndex = authorityAndSuffix.search(/[/?#\\]/);
  const authority = suffixIndex < 0
    ? authorityAndSuffix
    : authorityAndSuffix.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : authorityAndSuffix.slice(suffixIndex);

  if (parsed.username || parsed.password || authority.includes("@")) {
    throw new Error("Public origin must not contain credentials");
  }
  if (suffix !== "" && suffix !== "/") {
    throw new Error("Public origin must not contain a path, query, or fragment");
  }

  return parsed.origin;
}
