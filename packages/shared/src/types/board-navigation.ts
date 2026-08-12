/**
 * A native board navigation target.
 *
 * These values deliberately carry route semantics rather than a rendered URL.
 * The client supplies the active company UUID and maps the target to its typed
 * router destination.
 */
export type CompanyBoardRouteTarget =
  | { kind: "task"; taskNumber: number; hash: string | null }
  | { kind: "agent"; id: string }
  | { kind: "project"; id: string }
  | { kind: "routine"; id: string }
  | { kind: "approval"; id: string }
  | { kind: "inbox" }
  | { kind: "join_requests" }
  | { kind: "costs" };
