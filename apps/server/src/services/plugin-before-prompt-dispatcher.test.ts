import { describe, expect, it, vi } from "vitest";
import { DateTime } from "effect";
import type { Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginBeforePromptResult,
} from "@paperclipai/plugin-sdk";
import type {
  PluginWorkerHandle,
  PluginWorkerManager,
} from "./plugin-worker-manager.js";
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

function manifest(
  id: string,
  capabilities: PaperclipPluginManifestV1["capabilities"] = [
    "runtime.prompt.observe",
  ],
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

function installation(input: {
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

function promptInput(): PluginBeforePromptDispatchInput {
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

function worker(
  installation: PluginBeforePromptInstallation,
  input: {
    readonly manifestIdentity?: string;
    readonly supportedMethods?: readonly string[];
    readonly call?: PluginWorkerHandle["call"];
  } = {},
): PluginWorkerHandle {
  return {
    pluginId: installation.id,
    manifestIdentity:
      input.manifestIdentity ??
      pluginManifestIdentity(installation.manifestJson),
    status: "running",
    supportedMethods: input.supportedMethods ?? ["beforePrompt"],
    call: input.call ?? vi.fn(async () => null),
  } as unknown as PluginWorkerHandle;
}

function harness(input: {
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
      return readCount === 1 ? input.initial : input.final ?? input.initial;
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
    const explicit = input.workers && installation.id in input.workers
      ? input.workers[installation.id]
      : undefined;
    currentWorkers.set(
      installation.id,
      explicit ??
        worker(installation, {
          call: ((method, params, timeoutMs, scope) =>
            call(
              installation.id,
              method,
              params,
              timeoutMs,
              scope,
            )) as PluginWorkerHandle["call"],
        }),
    );
  }
  if (input.workers) {
    for (const [installationId, handle] of Object.entries(input.workers)) {
      if (handle === undefined) currentWorkers.set(installationId, undefined);
    }
  }
  const managerCall = vi.fn(async () => {
    throw new Error(
      "beforePrompt must call its captured worker handle directly",
    );
  });
  const workers = {
    getWorker: vi.fn((installationId: string) =>
      currentWorkers.get(installationId)
    ),
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
    setWorker(
      installationId: string,
      handle: PluginWorkerHandle | undefined,
    ) {
      currentWorkers.set(installationId, handle);
    },
  };
}

describe("plugin before-prompt dispatcher", () => {
  it("skips source inspection when no plugin is eligible", async () => {
    const subject = harness({
      initial: [
        installation({ id: "ordinary", order: 2, capabilities: [] }),
      ],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe(
      "Canonical request",
    );
    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe(
      "Canonical request",
    );

    expect(subject.source.resolve).not.toHaveBeenCalled();
    expect(subject.call).not.toHaveBeenCalled();
  });

  it("runs observers in install order with the exact scoped source", async () => {
    const second = installation({ id: "second", order: 2 });
    const first = installation({ id: "first", order: 1 });
    const subject = harness({
      initial: [second, first],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe(
      "Canonical request",
    );

    expect(subject.call.mock.calls.map((call) => call[0])).toEqual([
      "first",
      "second",
    ]);
    expect(subject.call.mock.calls[0]?.[1]).toBe("beforePrompt");
    expect(subject.call.mock.calls[0]?.[3]).toBe(
      PLUGIN_BEFORE_PROMPT_TIMEOUT_MS,
    );
    expect(subject.call.mock.calls[0]?.[4]).toEqual({
      companyId: "company-1",
      canonicalSession: {
        taskId: "task-1",
        sessionId: "session-1",
        snapshotHighWaterSeq: 7,
      },
    });
    expect(subject.call.mock.calls[0]?.[2]).toMatchObject({
      projectId: "project-1",
      sourceMessageId: "msg_source_0000000000000000001",
      sourceMessageSeq: 7,
      snapshotHighWaterSeq: 7,
    });
    expect(subject.managerCall).not.toHaveBeenCalled();
    expect(subject.installations.listReady).toHaveBeenLastCalledWith();
  });

  it("fails closed before source inspection when an approved hook is unavailable", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const subject = harness({
      initial: [approved],
      workers: {
        approved: worker(approved, { supportedMethods: [] }),
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toMatchObject({
      code: "plugin_before_prompt_dispatch_failed",
    });
    expect(subject.source.resolve).not.toHaveBeenCalled();
    expect(subject.call).not.toHaveBeenCalled();
  });

  it("rejects a source boundary that the canonical source reader does not confirm", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const subject = harness({
      initial: [approved],
      source: {
        resolve: vi.fn(async () => ({
          projectId: null,
          sourceMessageSeq: 6,
        })),
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "different Session boundary",
    );
    expect(subject.call).not.toHaveBeenCalled();
  });

  it("rejects any result outside the exact prompt contribution shape", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const invalid = harness({
      initial: [approved],
      results: {
        approved: { content: "memory" } as unknown as PluginBeforePromptResult,
      },
    });
    await expect(invalid.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "invalid result",
    );
  });

  it("fails closed on worker failure", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const failed = harness({ initial: [approved] });
    failed.call.mockRejectedValueOnce(new Error("worker crash"));
    await expect(failed.dispatcher.dispatch(promptInput())).rejects.toMatchObject({
      code: "plugin_before_prompt_dispatch_failed",
      cause: expect.objectContaining({ message: "worker crash" }),
    });
  });

  it("rejects a worker whose manifest identity does not match its installation", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const hook = vi.fn(async () => null);
    const subject = harness({
      initial: [approved],
      workers: {
        approved: worker(approved, {
          manifestIdentity: "mismatched-manifest",
          call: hook as PluginWorkerHandle["call"],
        }),
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "worker is unavailable or lacks beforePrompt",
    );
    expect(subject.source.resolve).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("never invokes a same-manifest replacement installed during source inspection", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const originalCall = vi.fn(async () => null);
    const replacementCall = vi.fn(async () => null);
    const original = worker(approved, {
      call: originalCall as PluginWorkerHandle["call"],
    });
    const replacement = worker(approved, {
      call: replacementCall as PluginWorkerHandle["call"],
    });
    const subject = harness({
      initial: [approved],
      workers: { approved: original },
    });
    vi.mocked(subject.source.resolve).mockImplementationOnce(async () => {
      subject.setWorker(approved.id, replacement);
      return { projectId: "project-1", sourceMessageSeq: 7 };
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "authority changed",
    );
    expect(originalCall).not.toHaveBeenCalled();
    expect(replacementCall).not.toHaveBeenCalled();
    expect(subject.managerCall).not.toHaveBeenCalled();
  });

  it("never invokes a same-manifest replacement installed while its hook runs", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const replacementCall = vi.fn(async () => null);
    const replacement = worker(approved, {
      call: replacementCall as PluginWorkerHandle["call"],
    });
    let subject: ReturnType<typeof harness>;
    const originalCall = vi.fn(async () => {
      subject.setWorker(approved.id, replacement);
      return null;
    });
    const original = worker(approved, {
      call: originalCall as PluginWorkerHandle["call"],
    });
    subject = harness({
      initial: [approved],
      workers: { approved: original },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "authority changed",
    );
    expect(originalCall).toHaveBeenCalledOnce();
    expect(replacementCall).not.toHaveBeenCalled();
    expect(subject.managerCall).not.toHaveBeenCalled();
  });

  it("rejects when an installation leaves the ready set during the hook", async () => {
    const before = installation({ id: "approved", order: 1 });
    const subject = harness({
      initial: [before],
      final: [],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "authority changed",
    );
  });

  it("revalidates acknowledged hooks and rejects config races", async () => {
    const before = installation({ id: "approved", order: 1 });
    const configChanged = harness({
      initial: [before],
      final: [{
        ...before,
        configId: "config-1",
        configUpdatedAt: new Date("2026-08-05T00:00:01.000Z"),
      }],
    });
    await expect(configChanged.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "authority changed",
    );
  });

  it("rejects config content drift even when persistence timestamps collide", async () => {
    const before = {
      ...installation({ id: "approved", order: 1 }),
      configId: "config-1",
      configUpdatedAt: new Date("2026-08-05T00:00:01.000Z"),
      configJson: { endpoint: "https://before.example" },
    };
    const subject = harness({
      initial: [before],
      final: [{
        ...before,
        configJson: { endpoint: "https://after.example" },
      }],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "authority changed",
    );
  });

  it("rejects a newly eligible hook crossing the barrier", async () => {
    const first = installation({ id: "first", order: 1 });
    const subject = harness({
      initial: [first],
      final: [first, installation({ id: "second", order: 2 })],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "authority changed",
    );
  });

  it("composes non-empty contributions in immutable install order", async () => {
    const second = installation({ id: "second", order: 2 });
    const first = installation({ id: "first", order: 1 });
    const subject = harness({
      initial: [second, first],
      results: {
        first: { prependText: "First prelude" },
        second: { prependText: "Second prelude" },
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe(
      "First prelude\n\nSecond prelude\n\nCanonical request",
    );
    expect(subject.installations.listReady).toHaveBeenCalledTimes(2);
  });
});

function canonicalSourceRow(input: {
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
  const canonical = type === "user"
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

function sourceDb(rows: readonly ReturnType<typeof canonicalSourceRow>[]): Db {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const secondJoin = vi.fn(() => ({ where }));
  const firstJoin = vi.fn(() => ({ innerJoin: secondJoin }));
  const from = vi.fn(() => ({ innerJoin: firstJoin }));
  return {
    select: vi.fn(() => ({ from })),
  } as unknown as Db;
}

describe("Postgres before-prompt canonical source reader", () => {
  it("accepts one exact readable user source and derives project scope", async () => {
    const reader = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({})]),
    );

    await expect(reader.resolve(promptInput())).resolves.toEqual({
      projectId: "project-from-db",
      sourceMessageSeq: 7,
    });
  });

  it("rejects text drift, non-source message kinds, and unprojected Sessions", async () => {
    const drift = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({ text: "different" })]),
    );
    await expect(drift.resolve(promptInput())).rejects.toThrow(
      "source text does not match",
    );

    const assistant = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({ type: "assistant" })]),
    );
    await expect(assistant.resolve(promptInput())).rejects.toThrow(
      "source text does not match",
    );

    const unprojected = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({ projectedEventSeq: 6 })]),
    );
    await expect(unprojected.resolve(promptInput())).rejects.toThrow(
      "outside the readable Session projection",
    );
  });

  it("rejects missing or ambiguous canonical source rows", async () => {
    const missing = createPostgresPluginBeforePromptSourceReader(sourceDb([]));
    await expect(missing.resolve(promptInput())).rejects.toThrow(
      "not one exact canonical Session message",
    );

    const row = canonicalSourceRow({});
    const ambiguous = createPostgresPluginBeforePromptSourceReader(
      sourceDb([row, row]),
    );
    await expect(ambiguous.resolve(promptInput())).rejects.toThrow(
      "not one exact canonical Session message",
    );
  });
});
