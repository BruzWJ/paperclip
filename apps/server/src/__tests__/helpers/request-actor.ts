import type {
  BoardKeyActor,
  BoardSessionActor,
  RequestActorMembership,
} from "../../http/request-actor.js";

type TestBoardActorBase = {
  userId?: string;
  userName?: string | null;
  userEmail?: string | null;
  companyIds?: string[];
  memberships?: RequestActorMembership[];
  isInstanceAdmin?: boolean;
};

type TestBoardSessionActor = TestBoardActorBase & {
  sessionId?: string;
};

type TestBoardKeyActor = TestBoardActorBase & {
  keyId?: string;
};

function canonicalMemberships(
  companyIds: readonly string[],
  memberships: readonly RequestActorMembership[] | undefined,
): RequestActorMembership[] {
  if (memberships) {
    return memberships.map((membership) => ({ ...membership }));
  }
  return companyIds.map((companyId) => ({
    companyId,
    membershipRole: "operator",
    status: "active",
  }));
}

/**
 * Canonical Better Auth browser actor for route-unit tests.
 *
 * Integration tests still authenticate through Better Auth. This helper keeps
 * isolated route tests on the same complete request-actor contract instead of
 * rebuilding partial pre-redesign actors in every fixture.
 */
export function testBoardSessionActor(
  input: TestBoardSessionActor = {},
): BoardSessionActor {
  const userId = input.userId ?? "test-user";
  const companyIds = [...(input.companyIds ?? [])];
  return {
    type: "board",
    source: "session",
    sessionId: input.sessionId ?? `test-session-${userId}`,
    userId,
    userName:
      input.userName === undefined ? "Test User" : input.userName,
    userEmail:
      input.userEmail === undefined
        ? "test@example.com"
        : input.userEmail,
    companyIds,
    memberships: canonicalMemberships(
      companyIds,
      input.memberships,
    ),
    isInstanceAdmin: input.isInstanceAdmin ?? false,
  };
}

/**
 * Canonical derivative board-key actor for tests of non-browser credentials.
 */
export function testBoardKeyActor(
  input: TestBoardKeyActor = {},
): BoardKeyActor {
  const userId = input.userId ?? "test-user";
  const companyIds = [...(input.companyIds ?? [])];
  return {
    type: "board",
    source: "board_key",
    keyId: input.keyId ?? `test-key-${userId}`,
    userId,
    userName:
      input.userName === undefined ? "Test User" : input.userName,
    userEmail:
      input.userEmail === undefined
        ? "test@example.com"
        : input.userEmail,
    companyIds,
    memberships: canonicalMemberships(
      companyIds,
      input.memberships,
    ),
    isInstanceAdmin: input.isInstanceAdmin ?? false,
  };
}
