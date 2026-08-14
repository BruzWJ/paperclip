import { and, asc, eq } from "drizzle-orm";
import { taskSessionMessages, taskSessions, pluginConfig, plugins, tasks, type Db } from "@paperclipai/db";
import type { PluginBeforePromptInput, PluginBeforePromptResult } from "@paperclipai/plugin-sdk";
import { taskSessionMessageFromRow } from "./task-session/projector.js";
import { canonicalTaskSessionJson } from "./task-session/store.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";
import type { PluginWorkerManager, PluginWorkerHandle } from "./plugin-worker-manager.js";

const PROMPT_OBSERVE_CAPABILITY = "runtime.prompt.observe";
const BEFORE_PROMPT_METHOD = "beforePrompt";

/** A before-prompt hook is a blocking prompt barrier, but cannot wait forever. */
export const PLUGIN_BEFORE_PROMPT_TIMEOUT_MS = 120_000;

export interface PluginBeforePromptDispatcher {
  dispatch(input: PluginBeforePromptDispatchInput): Promise<string>;
}

/** Project id and snapshot cutoff are host-derived inside the dispatcher. */
export type PluginBeforePromptDispatchInput = Omit<
  PluginBeforePromptInput,
  "projectId" | "snapshotHighWaterSeq"
>;

export interface PluginBeforePromptInstallation {
  readonly id: string;
  readonly pluginKey: string;
  readonly installOrder: number;
  readonly updatedAt: Date;
  readonly configId: string | null;
  readonly configUpdatedAt: Date | null;
  readonly configJson: Record<string, unknown> | null;
  readonly manifestJson: (typeof plugins.$inferSelect)["manifestJson"];
}

export interface PluginBeforePromptInstallationReader {
  listReady(): Promise<readonly PluginBeforePromptInstallation[]>;
}

interface PluginBeforePromptSourceResolution {
  readonly projectId: string | null;
  readonly sourceMessageSeq: number;
}

/** Independently proves the caller's source against the canonical Session. */
export interface PluginBeforePromptSourceReader {
  resolve(input: PluginBeforePromptDispatchInput): Promise<PluginBeforePromptSourceResolution>;
}

class PluginBeforePromptDispatchError extends Error {
  readonly code = "plugin_before_prompt_dispatch_failed";

  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginBeforePromptDispatchError";
  }
}

function fail(message: string, details: Record<string, unknown>, cause?: unknown): never {
  throw new PluginBeforePromptDispatchError(message, details, cause === undefined ? undefined : { cause });
}

function hasPromptObserveCapability(installation: PluginBeforePromptInstallation): boolean {
  return (
    Array.isArray(installation.manifestJson.capabilities) &&
    installation.manifestJson.capabilities.includes(PROMPT_OBSERVE_CAPABILITY)
  );
}

function assertEligibleInstallation(installation: PluginBeforePromptInstallation): void {
  if (!Number.isSafeInteger(installation.installOrder) || installation.installOrder < 1) {
    fail("Prompt-observing plugin has no valid install order", {
      pluginInstallationId: installation.id,
      pluginKey: installation.pluginKey,
    });
  }
  if (installation.manifestJson.id !== installation.pluginKey) {
    fail("Prompt-observing plugin installation identity is inconsistent", {
      pluginInstallationId: installation.id,
      pluginKey: installation.pluginKey,
    });
  }
}

function assertWorkerReady(
  installation: PluginBeforePromptInstallation,
  worker: PluginWorkerHandle | undefined,
): asserts worker is PluginWorkerHandle {
  const expectedManifestIdentity = pluginManifestIdentity(installation.manifestJson);
  if (
    worker?.status !== "running" ||
    !worker.supportedMethods.includes(BEFORE_PROMPT_METHOD) ||
    worker.manifestIdentity !== expectedManifestIdentity
  ) {
    fail("Prompt-observing plugin worker is unavailable or lacks beforePrompt", {
      pluginInstallationId: installation.id,
      pluginKey: installation.pluginKey,
      workerStatus: worker?.status ?? "missing",
      expectedManifestIdentity,
      workerManifestIdentity: worker?.manifestIdentity ?? null,
    });
  }
}

function sameInstallationSnapshot(
  before: PluginBeforePromptInstallation,
  after: PluginBeforePromptInstallation,
): boolean {
  return (
    before.id === after.id &&
    before.pluginKey === after.pluginKey &&
    before.installOrder === after.installOrder &&
    before.updatedAt.getTime() === after.updatedAt.getTime() &&
    before.configId === after.configId &&
    (before.configUpdatedAt?.getTime() ?? null) === (after.configUpdatedAt?.getTime() ?? null) &&
    canonicalTaskSessionJson(before.configJson) === canonicalTaskSessionJson(after.configJson) &&
    canonicalTaskSessionJson(before.manifestJson) === canonicalTaskSessionJson(after.manifestJson) &&
    hasPromptObserveCapability(after) &&
    after.manifestJson.id === after.pluginKey
  );
}

function sortInstallations(
  installations: readonly PluginBeforePromptInstallation[],
): PluginBeforePromptInstallation[] {
  return [...installations].sort((left, right) => {
    return left.installOrder - right.installOrder || left.id.localeCompare(right.id);
  });
}

function readPromptContribution(
  result: PluginBeforePromptResult,
  installation: PluginBeforePromptInstallation,
): string | null {
  if (result === null) return null;
  if (
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    typeof result.prependText !== "string" ||
    result.prependText.trim().length === 0
  ) {
    fail("Plugin before-prompt hook returned an invalid result", {
      pluginInstallationId: installation.id,
      pluginKey: installation.pluginKey,
    });
  }
  return result.prependText;
}

function createPostgresPluginBeforePromptInstallationReader(db: Db): PluginBeforePromptInstallationReader {
  return {
    async listReady() {
      return db
        .select({
          id: plugins.id,
          pluginKey: plugins.pluginKey,
          installOrder: plugins.installOrder,
          updatedAt: plugins.updatedAt,
          manifestJson: plugins.manifestJson,
          configId: pluginConfig.id,
          configUpdatedAt: pluginConfig.updatedAt,
          configJson: pluginConfig.configJson,
        })
        .from(plugins)
        .leftJoin(pluginConfig, eq(pluginConfig.pluginId, plugins.id))
        .where(eq(plugins.status, "ready"))
        .orderBy(asc(plugins.installOrder), asc(plugins.id));
    },
  };
}

export function createPostgresPluginBeforePromptSourceReader(db: Db): PluginBeforePromptSourceReader {
  return {
    async resolve(input) {
      if (
        input.sourceMessageId.length === 0 ||
        !Number.isSafeInteger(input.sourceMessageSeq) ||
        input.sourceMessageSeq < 0
      ) {
        fail("Before-prompt source boundary is invalid", {
          companyId: input.companyId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          sourceMessageId: input.sourceMessageId,
        });
      }

      const rows = await db
        .select({
          session: taskSessions,
          message: taskSessionMessages,
          projectId: tasks.projectId,
        })
        .from(taskSessions)
        .innerJoin(tasks, and(eq(tasks.companyId, taskSessions.companyId), eq(tasks.id, taskSessions.taskId)))
        .innerJoin(
          taskSessionMessages,
          and(
            eq(taskSessionMessages.companyId, taskSessions.companyId),
            eq(taskSessionMessages.taskId, taskSessions.taskId),
            eq(taskSessionMessages.sessionId, taskSessions.id),
            eq(taskSessionMessages.id, input.sourceMessageId),
            eq(taskSessionMessages.seq, input.sourceMessageSeq),
          ),
        )
        .where(
          and(
            eq(taskSessions.companyId, input.companyId),
            eq(taskSessions.taskId, input.taskId),
            eq(taskSessions.id, input.sessionId),
          ),
        )
        .limit(2);
      if (rows.length !== 1) {
        fail("Before-prompt source is not one exact canonical Session message", {
          companyId: input.companyId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          sourceMessageId: input.sourceMessageId,
          sourceMessageSeq: input.sourceMessageSeq,
        });
      }

      const row = rows[0]!;
      if (
        row.session.integrityState !== "ready" ||
        !Number.isSafeInteger(row.session.projectedEventSeq) ||
        row.session.projectedEventSeq < input.sourceMessageSeq
      ) {
        fail("Before-prompt source is outside the readable Session projection", {
          companyId: input.companyId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          sourceMessageSeq: input.sourceMessageSeq,
          projectedEventSeq: row.session.projectedEventSeq,
          integrityState: row.session.integrityState,
        });
      }

      let sourceMessage;
      try {
        sourceMessage = taskSessionMessageFromRow(row.message);
      } catch (cause) {
        fail(
          "Before-prompt source message failed canonical decoding",
          {
            companyId: input.companyId,
            taskId: input.taskId,
            sessionId: input.sessionId,
            sourceMessageId: input.sourceMessageId,
          },
          cause,
        );
      }
      if (
        (sourceMessage.type !== "user" && sourceMessage.type !== "synthetic") ||
        sourceMessage.text !== input.sourceText
      ) {
        fail("Before-prompt source text does not match its canonical Session message", {
          companyId: input.companyId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          sourceMessageId: input.sourceMessageId,
          sourceMessageType: sourceMessage.type,
        });
      }

      return Object.freeze({
        projectId: row.projectId,
        sourceMessageSeq: row.message.seq,
      });
    },
  };
}

/**
 * Runs every eligible hook synchronously in immutable installation order.
 * One hook failure, invalid result, or concurrent installation authority
 * change rejects the complete prompt. Valid preludes are composed only after
 * the complete barrier succeeds.
 */
export function createPluginBeforePromptDispatcher(options: {
  installations: PluginBeforePromptInstallationReader;
  source: PluginBeforePromptSourceReader;
  workers: PluginWorkerManager;
}): PluginBeforePromptDispatcher {
  return {
    async dispatch(input) {
      const loaded = await options.installations.listReady();
      const eligible = sortInstallations(loaded.filter(hasPromptObserveCapability));
      if (eligible.length === 0) return input.sourceText;

      const contributions: string[] = [];
      const bindings = eligible.map((installation) => {
        assertEligibleInstallation(installation);
        const worker = options.workers.getWorker(installation.id);
        assertWorkerReady(installation, worker);
        return Object.freeze({ installation, worker });
      });
      const source = await options.source.resolve(input);
      if (source.sourceMessageSeq !== input.sourceMessageSeq) {
        fail("Before-prompt source reader returned a different Session boundary", {
          companyId: input.companyId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          sourceMessageId: input.sourceMessageId,
        });
      }
      const hookInput: PluginBeforePromptInput = Object.freeze({
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        runId: input.runId,
        agentId: input.agentId,
        projectId: source.projectId,
        sourceText: input.sourceText,
        promptKind: input.promptKind,
        sessionOperation: input.sessionOperation,
        refId: input.refId,
        refOrdinal: input.refOrdinal,
        segmentOrdinal: input.segmentOrdinal,
        sourceMessageId: input.sourceMessageId,
        sourceMessageSeq: source.sourceMessageSeq,
        contextAccess: Object.freeze({ ...input.contextAccess }),
        snapshotHighWaterSeq: source.sourceMessageSeq,
      });

      for (const binding of bindings) {
        const { installation, worker } = binding;
        if (options.workers.getWorker(installation.id) !== worker) {
          fail("Prompt-observing plugin authority changed during beforePrompt", {
            pluginInstallationId: installation.id,
            pluginKey: installation.pluginKey,
          });
        }
        assertWorkerReady(installation, worker);

        let result: PluginBeforePromptResult;
        try {
          result = await worker.call(
            BEFORE_PROMPT_METHOD,
            structuredClone(hookInput),
            PLUGIN_BEFORE_PROMPT_TIMEOUT_MS,
            {
              companyId: input.companyId,
              canonicalSession: {
                taskId: input.taskId,
                sessionId: input.sessionId,
                snapshotHighWaterSeq: source.sourceMessageSeq,
              },
            },
          );
        } catch (cause) {
          fail(
            "Plugin before-prompt hook failed",
            {
              pluginInstallationId: installation.id,
              pluginKey: installation.pluginKey,
            },
            cause,
          );
        }

        const contribution = readPromptContribution(result, installation);
        if (contribution !== null) contributions.push(contribution);
      }

      // The hooks are a blocking barrier, so installation authority
      // must be re-read after the last worker returns. This compares the full
      // ordered eligible set, including hooks that returned no text, so a
      // concurrent install, upgrade, disable, reorder, or config change can
      // never cross the provider-dispatch boundary unnoticed.
      const currentRows = await options.installations.listReady();
      const currentEligible = sortInstallations(currentRows.filter(hasPromptObserveCapability));
      if (currentEligible.length !== eligible.length) {
        fail("Prompt-observing plugin authority changed during beforePrompt", {
          beforeInstallationIds: eligible.map((entry) => entry.id),
          afterInstallationIds: currentEligible.map((entry) => entry.id),
        });
      }
      for (let index = 0; index < bindings.length; index += 1) {
        const binding = bindings[index]!;
        const before = binding.installation;
        const after = currentEligible[index];
        if (!after || !sameInstallationSnapshot(before, after)) {
          fail("Prompt-observing plugin authority changed during beforePrompt", {
            pluginInstallationId: before.id,
            pluginKey: before.pluginKey,
          });
        }
        if (options.workers.getWorker(after.id) !== binding.worker) {
          fail("Prompt-observing plugin authority changed during beforePrompt", {
            pluginInstallationId: before.id,
            pluginKey: before.pluginKey,
          });
        }
        assertWorkerReady(after, binding.worker);
      }

      return contributions.length === 0
        ? input.sourceText
        : `${contributions.join("\n\n")}\n\n${input.sourceText}`;
    },
  };
}

export function createPostgresPluginBeforePromptDispatcher(
  db: Db,
  workers: PluginWorkerManager,
): PluginBeforePromptDispatcher {
  return createPluginBeforePromptDispatcher({
    installations: createPostgresPluginBeforePromptInstallationReader(db),
    source: createPostgresPluginBeforePromptSourceReader(db),
    workers,
  });
}
