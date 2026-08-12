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

export interface UnauthenticatedActor {
  type: "none";
  source: "none";
  userId?: never;
  userName?: never;
  userEmail?: never;
  companyIds?: never;
  sessionId?: never;
  memberships?: never;
  isInstanceAdmin?: never;
  keyId?: never;
}

export type RequestActor = BoardActor | UnauthenticatedActor;

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
