import {
  taskSessionContextEpochs,
  taskSessionEventSequences,
  taskSessionMessageIdAllocators,
  taskSessions,
  type Db,
} from "@paperclipai/db";

type TaskSessionRootTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateTaskSessionRootInput {
  id: string;
  companyId: string;
  taskId: string;
  parentSessionId: string | null;
  projectId: string;
  title: string;
  directory: string;
  workspaceId?: string | null;
  subpath?: string | null;
  now: Date;
}

/**
 * Creates the three physical PostgreSQL records that make one Paperclip
 * Session usable: the flattened Session aggregate, its event sequence, its
 * message-id allocator, and its persistent context-epoch state.
 */
export async function createTaskSessionRootInTx(
  tx: TaskSessionRootTransaction,
  input: CreateTaskSessionRootInput,
) {
  if (!input.projectId) {
    throw new TypeError("Task Session projectId must be non-empty");
  }
  if (!input.title) {
    throw new TypeError("Task Session title must be non-empty");
  }
  if (!input.directory.startsWith("/")) {
    throw new TypeError("Task Session directory must be absolute");
  }

  const session = await tx
    .insert(taskSessions)
    .values({
      id: input.id,
      companyId: input.companyId,
      taskId: input.taskId,
      parentSessionId: input.parentSessionId,
      projectId: input.projectId,
      agent: null,
      model: null,
      title: input.title,
      directory: input.directory,
      workspaceId: input.workspaceId ?? null,
      subpath: input.subpath ?? null,
      revert: null,
      timeCreated: input.now,
      timeUpdated: input.now,
      timeArchived: null,
      projectedEventSeq: -1,
      integrityState: "ready",
      migratedAt: input.now,
      refAdmittableAt: input.now,
      purgeFencedAt: null,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!session) {
    throw new Error("Task Session root was not persisted");
  }

  const eventSequence = await tx
    .insert(taskSessionEventSequences)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.id,
      seq: -1,
      ownerId: null,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!eventSequence) {
    throw new Error("Task Session event sequence was not persisted");
  }

  const messageIdAllocator = await tx
    .insert(taskSessionMessageIdAllocators)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.id,
      lastOrdinal: 0,
      updatedAt: input.now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!messageIdAllocator) {
    throw new Error("Task Session message-id allocator was not persisted");
  }

  const contextEpoch = await tx
    .insert(taskSessionContextEpochs)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.id,
      baseline: null,
      snapshot: null,
      baselineSeq: null,
      generation: 0,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!contextEpoch) {
    throw new Error("Task Session context epoch was not persisted");
  }

  return { session, eventSequence, messageIdAllocator, contextEpoch };
}
