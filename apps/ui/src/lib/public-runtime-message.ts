const INTERNAL_RUNTIME_NAME = /acpx/gi;

/** Keep the packaged runtime bridge out of operator-facing diagnostics. */
export function publicRuntimeMessage(
  message: string,
  fallback = "The local agent runtime is unavailable.",
): string {
  const sanitized = message
    .replace(INTERNAL_RUNTIME_NAME, "local agent runtime")
    .trim();
  return sanitized || fallback;
}
