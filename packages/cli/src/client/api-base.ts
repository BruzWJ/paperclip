export function parseExactApiBase(apiBase: string): string {
  if (!apiBase || apiBase.trim() !== apiBase) {
    throw new Error("API base must be exact and non-empty.");
  }
  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error("API base must be a valid HTTP or HTTPS origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.origin !== apiBase
  ) {
    throw new Error("API base must be its exact canonical HTTP or HTTPS origin.");
  }
  return apiBase;
}
