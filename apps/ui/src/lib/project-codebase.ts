export function isAbsoluteProjectFolder(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function isValidProjectRepositoryUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

export function isSafeProjectRepositoryUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function formatProjectRepositoryUrl(value: string) {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return parsed.host;
    const owner = segments[0];
    const repo = segments[1]?.replace(/\.git$/i, "");
    return owner && repo ? `${parsed.host}/${owner}/${repo}` : parsed.host;
  } catch {
    return value;
  }
}
