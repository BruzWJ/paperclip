export interface RequestActorMembership {
  companyId: string;
  membershipRole?: string | null;
  status?: string;
}

interface BoardActorBase {
  type: "board";
  userId: string;
  userName: string | null;
  userEmail: string | null;
  companyIds: string[];
  memberships: RequestActorMembership[];
  isInstanceAdmin: boolean;
  agentId?: never;
  companyId?: never;
  runId?: never;
  onBehalfOfUserId?: never;
  onBehalfOfMemberships?: never;
}

export type BoardSessionActor = BoardActorBase & {
  source: "session";
  sessionId: string;
  keyId?: never;
};

export type BoardKeyActor = BoardActorBase & {
  source: "board_key";
  keyId: string;
  sessionId?: never;
};

export type BoardActor = BoardSessionActor | BoardKeyActor;

/**
 * Agent identity is accepted only at the isolated internal/runtime boundary.
 * Generic REST mounts reject this variant before a route handler can run.
 */
export interface RuntimeAgentActor {
  type: "agent";
  source: "internal";
  agentId: string;
  companyId: string;
  runId: string;
  onBehalfOfUserId?: string | null;
  onBehalfOfMemberships?: RequestActorMembership[];
  userId?: never;
  userName?: never;
  userEmail?: never;
  companyIds?: never;
  memberships?: never;
  isInstanceAdmin?: never;
  sessionId?: never;
  keyId?: never;
}

export interface UnauthenticatedActor {
  type: "none";
  source: "none";
  userId?: never;
  userName?: never;
  userEmail?: never;
  agentId?: never;
  companyId?: never;
  companyIds?: never;
  sessionId?: never;
  memberships?: never;
  onBehalfOfMemberships?: never;
  isInstanceAdmin?: never;
  keyId?: never;
  runId?: never;
  onBehalfOfUserId?: never;
}

export type RequestActor =
  | BoardActor
  | RuntimeAgentActor
  | UnauthenticatedActor;

export function isNonEmptyActorId(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value === value.trim()
  );
}

export function isBoardActor(actor: unknown): actor is BoardActor {
  if (
    !actor
    || typeof actor !== "object"
    || !("type" in actor)
    || actor.type !== "board"
    || !("userId" in actor)
    || !isNonEmptyActorId(actor.userId)
  ) {
    return false;
  }
  if ("source" in actor && actor.source === "session") {
    return "sessionId" in actor && isNonEmptyActorId(actor.sessionId);
  }
  if ("source" in actor && actor.source === "board_key") {
    return "keyId" in actor && isNonEmptyActorId(actor.keyId);
  }
  return false;
}
