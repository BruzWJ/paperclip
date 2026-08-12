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
