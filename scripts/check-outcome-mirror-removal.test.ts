import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertOutcomeMirrorRemoval,
  listOutcomeMirrorRemovalFiles,
  scanOutcomeMirrorRemovalFiles,
} from "./check-outcome-mirror-removal.ts";

test("scans canonical tasks directories", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-outcome-boundary-"));
  try {
    const directory = join(root, "apps/server/src/tasks");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "stale.ts"),
      "export const stale = normalizedFinal;\n",
    );

    const files = listOutcomeMirrorRemovalFiles(root);
    assert.ok(files.some((file) => file.path === "apps/server/src/tasks/stale.ts"));
    assert.deepEqual(
      scanOutcomeMirrorRemovalFiles(files).map((entry) => entry.term),
      ["normalizedFinal"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects every retired outcome mirror spelling", () => {
  const terms = [
    "taskExecutionOutcomeTranslations",
    "task_execution_outcome_translations",
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
