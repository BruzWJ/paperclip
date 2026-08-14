import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PostgresRuntimeTaskActionServiceOptions } from "./services/index.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

export type CausalRuntimeStartupAssembly = Pick<
  PostgresRuntimeTaskActionServiceOptions,
  "dispatchPersistedRef" | "taskExecutionCancellation"
>;

export function createStartupAssembly<T>() {
  let complete!: (assembly: T) => void;
  const ready = new Promise<T>((resolveReady) => {
    complete = resolveReady;
  });
  return { ready, complete };
}

export async function closeDatabaseClient(database: unknown): Promise<void> {
  const client = (
    database as {
      $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
    }
  ).$client;
  if (client?.end) await client.end({ timeout: 5 });
}

export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}
