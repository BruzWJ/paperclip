export const TASK_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** Parse exact persisted task display metadata without normalization. */
export function parseTaskIdentifier(value: string): string | null {
  return TASK_IDENTIFIER_RE.test(value) ? value : null;
}
