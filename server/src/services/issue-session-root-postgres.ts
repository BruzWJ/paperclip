import {
  issueSessionContextEpochs,
  issueSessionEventSequences,
  issueSessionMessageIdAllocators,
  issueSessions,
  type Db,
} from "@paperclipai/db";

type IssueSessionRootTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateIssueSessionRootInput {
  id: string;
  companyId: string;
  issueId: string;
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
export async function createIssueSessionRootInTx(
  tx: IssueSessionRootTransaction,
  input: CreateIssueSessionRootInput,
) {
  if (!input.projectId) {
    throw new TypeError("Issue Session projectId must be non-empty");
  }
  if (!input.title) {
    throw new TypeError("Issue Session title must be non-empty");
  }
  if (!input.directory.startsWith("/")) {
    throw new TypeError("Issue Session directory must be absolute");
  }

  const session = await tx
    .insert(issueSessions)
    .values({
      id: input.id,
      companyId: input.companyId,
      issueId: input.issueId,
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
    throw new Error("Issue Session root was not persisted");
  }

  const eventSequence = await tx
    .insert(issueSessionEventSequences)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      sessionId: input.id,
      seq: -1,
      ownerId: null,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!eventSequence) {
    throw new Error("Issue Session event sequence was not persisted");
  }

  const messageIdAllocator = await tx
    .insert(issueSessionMessageIdAllocators)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      sessionId: input.id,
      lastOrdinal: 0,
      updatedAt: input.now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!messageIdAllocator) {
    throw new Error("Issue Session message-id allocator was not persisted");
  }

  const contextEpoch = await tx
    .insert(issueSessionContextEpochs)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      sessionId: input.id,
      baseline: null,
      snapshot: null,
      baselineSeq: null,
      generation: 0,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!contextEpoch) {
    throw new Error("Issue Session context epoch was not persisted");
  }

  return { session, eventSequence, messageIdAllocator, contextEpoch };
}
