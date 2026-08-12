const CANONICAL_TASK_NUMBER_RE = /^[1-9]\d*$/;
export const MAX_TASK_NUMBER = 2_147_483_647;

/** Whether a value fits the canonical positive PostgreSQL task counter. */
export function isCanonicalTaskNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_TASK_NUMBER;
}

/** Parse an exact positive decimal task number from a board route segment. */
export function parseTaskNumber(value: string): number | null {
  if (!CANONICAL_TASK_NUMBER_RE.test(value)) return null;
  const taskNumber = Number(value);
  return isCanonicalTaskNumber(taskNumber) ? taskNumber : null;
}
