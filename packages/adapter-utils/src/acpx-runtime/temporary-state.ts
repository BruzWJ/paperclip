import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTemporarySessionKey(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

export async function createTemporaryStateDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function removeTemporaryStateDir(stateDir: string): Promise<void> {
  await rm(stateDir, { recursive: true, force: true });
}
