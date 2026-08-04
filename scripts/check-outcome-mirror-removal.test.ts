import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOutcomeMirrorRemoval,
  scanOutcomeMirrorRemovalFiles,
} from "./check-outcome-mirror-removal.ts";

test("rejects every retired outcome mirror spelling", () => {
  const terms = [
    "issueExecutionOutcomeTranslations",
    "issue_execution_outcome_translations",
    "normalizedFinal",
    "normalized_final",
    "normalized-final",
  ] as const;

  for (const term of terms) {
    const violations = scanOutcomeMirrorRemovalFiles([
      {
        path: "apps/server/src/services/legacy-finalizer.ts",
        source: `export const stale = ${JSON.stringify(term)};`,
      },
    ]);
    assert.deepEqual(
      violations.map((entry) => entry.term),
      [term],
    );
  }
});

test("accepts only the canonical reference owners in the repository", () => {
  assert.doesNotThrow(() => assertOutcomeMirrorRemoval());
});
