import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertDonorLockStructure } from "./check-opencode-session-donor.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LOCK_PATH = path.join(REPO_ROOT, "opencode-donor.lock.json");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const readLock = async () => JSON.parse(await readFile(LOCK_PATH, "utf8"));

test("current exact Session donor lock passes", async () => {
  const lock = await readLock();
  assert.doesNotThrow(() => assertDonorLockStructure(lock));
  assert.deepEqual(Object.keys(lock), ["version", "donor", "schema", "coreV2"]);
});

test("lock structure rejects widened or retired evidence", async (t) => {
  const lock = await readLock();

  await t.test("top-level evidence cannot be added", () => {
    const mutated = clone(lock);
    mutated.productionCompaction = {};
    assert.throws(() => assertDonorLockStructure(mutated), /donor lock keys changed/);
  });

  await t.test("six schema roots are exact", () => {
    const mutated = clone(lock);
    mutated.schema.roots.pop();
    assert.throws(() => assertDonorLockStructure(mutated), /Schema roots changed/);
  });

  await t.test("schema exclusions are exact paths", () => {
    const mutated = clone(lock);
    mutated.schema.exclusions.push("packages/schema/src/session*.ts");
    assert.throws(() => assertDonorLockStructure(mutated), /Schema exclusions changed/);
  });

  await t.test("core runner files cannot enter the adoption list", () => {
    const mutated = clone(lock);
    mutated.coreV2.files[0].sourcePath = "packages/core/src/session/runner/llm.ts";
    assert.throws(() => assertDonorLockStructure(mutated), /Core Session file manifest changed/);
  });

  await t.test("evidence hashes stay sealed", () => {
    const mutated = clone(lock);
    mutated.schema.staticRelativeClosure[0].sha256 = "not-a-hash";
    assert.throws(() => assertDonorLockStructure(mutated), /sha256 is invalid/);
  });
});
