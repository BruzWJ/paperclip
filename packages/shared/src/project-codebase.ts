export function isAbsoluteProjectFolder(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    (value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\/.test(value))
  );
}

export function isCanonicalProjectRepositoryUrl(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.href === value &&
      url.pathname.split("/").filter(Boolean).length >= 2
    );
  } catch {
    return false;
  }
}
