import { describe, expect, it, vi } from "vitest";
import { DateTime } from "effect";
import type { Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginBeforePromptResult } from "@paperclipai/plugin-sdk";
import type { PluginWorkerHandle, PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  createPluginBeforePromptDispatcher,
  createPostgresPluginBeforePromptSourceReader,
  PLUGIN_BEFORE_PROMPT_TIMEOUT_MS,
  type PluginBeforePromptDispatchInput,
  type PluginBeforePromptInstallation,
  type PluginBeforePromptInstallationReader,
  type PluginBeforePromptSourceReader,
} from "./plugin-before-prompt-dispatcher.js";
import { encodeTaskSessionMessageData } from "./task-session/store.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";
const NOW = new Date("2026-08-05T00:00:00.000Z");

export function manifest(
  id: string,
  capabilities: PaperclipPluginManifestV1["capabilities"] = ["runtime.prompt.observe"],
): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "1.0.0",
    displayName: id,
    description: `${id} plugin`,
    author: "Paperclip",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

export function installation(input: {
  id: string;
  order: number;
  key?: string;
  capabilities?: PaperclipPluginManifestV1["capabilities"];
  updatedAt?: Date;
}): PluginBeforePromptInstallation {
  const key = input.key ?? `paperclip.${input.id}`;
  const pluginManifest = manifest(key, input.capabilities);
  return {
    id: input.id,
    pluginKey: key,
    installOrder: input.order,
    updatedAt: input.updatedAt ?? NOW,
    configId: null,
    configUpdatedAt: null,
    configJson: null,
    manifestJson: pluginManifest,
  };
}

export function promptInput(): PluginBeforePromptDispatchInput {
  return {
    companyId: "company-1",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    agentId: "agent-1",
    sourceText: "Canonical request",
    promptKind: "base",
    sessionOperation: "new",
    refId: "ref-1",
    refOrdinal: 0,
    segmentOrdinal: 0,
    sourceMessageId: "msg_source_0000000000000000001",
    sourceMessageSeq: 7,
    contextAccess: {
      carry_context: false,
      read_task_comments: true,
      read_task_agent_run: false,
      list_sub_tasks: false,
      read_sub_task_comments: false,
      read_sub_task_agent_run: false,
      list_company_tasks: false,
      read_company_task_comments: false,
      read_company_task_agent_run: false,
    },
  };
}

export function worker(
  installation: PluginBeforePromptInstallation,
  input: {
    readonly manifestIdentity?: string;
    readonly supportedMethods?: readonly string[];
    readonly call?: PluginWorkerHandle["call"];
  } = {},
): PluginWorkerHandle {
  return {
    pluginId: installation.id,
    manifestIdentity: input.manifestIdentity ?? pluginManifestIdentity(installation.manifestJson),
    status: "running",
    supportedMethods: input.supportedMethods ?? ["beforePrompt"],
    call: input.call ?? vi.fn(async () => null),
  } as unknown as PluginWorkerHandle;
}

export function harness(input: {
  initial: readonly PluginBeforePromptInstallation[];
  final?: readonly PluginBeforePromptInstallation[];
  results?: Readonly<Record<string, PluginBeforePromptResult>>;
  workers?: Readonly<Record<string, PluginWorkerHandle | undefined>>;
  source?: PluginBeforePromptSourceReader;
}) {
  let readCount = 0;
  const installations: PluginBeforePromptInstallationReader = {
    listReady: vi.fn(async () => {
      readCount += 1;
      return readCount === 1 ? input.initial : (input.final ?? input.initial);
    }),
  };
  const call = vi.fn(
    async (
      installationId: string,
      _method: string,
      _params: unknown,
      _timeoutMs?: number,
      _scope?: unknown,
    ) => input.results?.[installationId] ?? null,
  );
  const currentWorkers = new Map<string, PluginWorkerHandle | undefined>();
  for (const installation of input.initial) {
    const explicit =
      input.workers && installation.id in input.workers ? input.workers[installation.id] : undefined;
    currentWorkers.set(
      installation.id,
      explicit ??
        worker(installation, {
          call: ((method, params, timeoutMs, scope) =>
            call(installation.id, method, params, timeoutMs, scope)) as PluginWorkerHandle["call"],
        }),
    );
  }
  if (input.workers) {
    for (const [installationId, handle] of Object.entries(input.workers)) {
      if (handle === undefined) currentWorkers.set(installationId, undefined);
    }
  }
  const managerCall = vi.fn(async () => {
    throw new Error("beforePrompt must call its captured worker handle directly");
  });
  const workers = {
    getWorker: vi.fn((installationId: string) => currentWorkers.get(installationId)),
    call: managerCall,
  } as unknown as PluginWorkerManager;
  const source = input.source ?? {
    resolve: vi.fn(async () => ({
      projectId: "project-1",
      sourceMessageSeq: 7,
    })),
  };
  return {
    dispatcher: createPluginBeforePromptDispatcher({
      installations,
      source,
      workers,
    }),
    installations,
    source,
    workers,
    call,
    managerCall,
    setWorker(installationId: string, handle: PluginWorkerHandle | undefined) {
      currentWorkers.set(installationId, handle);
    },
  };
}
export type PluginBeforePromptHarness = ReturnType<typeof harness>;

export function canonicalSourceRow(input: {
  text?: string;
  seq?: number;
  type?: "user" | "synthetic" | "assistant";
  projectedEventSeq?: number;
  integrityState?: "building" | "ready" | "archived" | "purge_fenced";
}) {
  const source = promptInput();
  const type = input.type ?? "user";
  const createdAt = new Date("2026-08-05T01:00:00.000Z");
  const canonicalTime = DateTime.makeUnsafe(createdAt);
  const canonical =
    type === "user"
      ? {
          id: source.sourceMessageId,
          type,
          text: input.text ?? source.sourceText,
          files: [],
          agents: [],
          time: { created: canonicalTime },
        }
      : type === "synthetic"
        ? {
            id: source.sourceMessageId,
            type,
            sessionID: source.sessionId,
            text: input.text ?? source.sourceText,
            time: { created: canonicalTime },
          }
        : {
            id: source.sourceMessageId,
            type,
            agent: "agent",
            content: [],
            time: { created: canonicalTime },
          };
  const message = {
    id: source.sourceMessageId,
    companyId: source.companyId,
    taskId: source.taskId,
    sessionId: source.sessionId,
    seq: input.seq ?? source.sourceMessageSeq,
    modelStateSeq: input.seq ?? source.sourceMessageSeq,
    type,
    data: encodeTaskSessionMessageData(canonical as never),
    runId: null,
    ownershipEpoch: null,
    agentId: null,
    adapterConfigRevisionId: null,
    timeCreated: createdAt,
    timeUpdated: createdAt,
  };
  return {
    session: {
      integrityState: input.integrityState ?? "ready",
      projectedEventSeq: input.projectedEventSeq ?? source.sourceMessageSeq,
    },
    message,
    projectId: "project-from-db",
  };
}

export function sourceDb(rows: readonly ReturnType<typeof canonicalSourceRow>[]): Db {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const secondJoin = vi.fn(() => ({ where }));
  const firstJoin = vi.fn(() => ({ innerJoin: secondJoin }));
  const from = vi.fn(() => ({ innerJoin: firstJoin }));
  return {
    select: vi.fn(() => ({ from })),
  } as unknown as Db;
}

export { describe, expect, it, vi, createPostgresPluginBeforePromptSourceReader };
export { PLUGIN_BEFORE_PROMPT_TIMEOUT_MS };
export type { PluginBeforePromptResult, PluginWorkerHandle };
