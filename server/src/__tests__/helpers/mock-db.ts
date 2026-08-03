import type { Db } from "@paperclipai/db";
import { vi } from "vitest";

export type MockDbOperation =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "execute";

export type MockDbCall = {
  operation: MockDbOperation;
  method: string;
  args: unknown[];
};

type QueuedResult = unknown | Error | (() => unknown | Promise<unknown>);

export type MockDbPlan = Partial<
  Record<MockDbOperation, readonly QueuedResult[]>
>;

export type MockDbHarness = {
  db: Db;
  calls: MockDbCall[];
  remaining(operation: MockDbOperation): number;
};

const queryMethods = new Set([
  "from",
  "where",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "innerJoin",
  "orderBy",
  "groupBy",
  "having",
  "limit",
  "offset",
  "for",
  "values",
  "set",
  "returning",
  "onConflictDoNothing",
  "onConflictDoUpdate",
]);

/**
 * A deterministic fluent-call mock, not an in-memory database. Each top-level
 * operation consumes exactly one predeclared result when awaited; query-builder
 * calls are recorded for focused assertions and never interpret or execute SQL.
 */
export function createMockDb(plan: MockDbPlan = {}): MockDbHarness {
  const calls: MockDbCall[] = [];
  const queues = new Map<MockDbOperation, QueuedResult[]>(
    (["select", "insert", "update", "delete", "execute"] as const).map(
      (operation) => [operation, [...(plan[operation] ?? [])]],
    ),
  );

  const consume = async (operation: MockDbOperation): Promise<unknown> => {
    const queue = queues.get(operation)!;
    if (queue.length === 0) {
      throw new Error(`Mock DB has no queued ${operation} result.`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? await next() : next;
  };

  const makeQuery = (operation: Exclude<MockDbOperation, "execute">) => {
    let promise: Promise<unknown> | null = null;
    const resolve = () => (promise ??= consume(operation));
    let proxy: unknown;
    proxy = new Proxy({}, {
      get(_target, property) {
        if (property === "then") {
          const result = resolve();
          return result.then.bind(result);
        }
        if (property === "catch") {
          const result = resolve();
          return result.catch.bind(result);
        }
        if (property === "finally") {
          const result = resolve();
          return result.finally.bind(result);
        }
        if (typeof property === "string" && queryMethods.has(property)) {
          return (...args: unknown[]) => {
            calls.push({ operation, method: property, args });
            return proxy;
          };
        }
        return undefined;
      },
    });
    return proxy;
  };

  const db = {
    select: vi.fn((...args: unknown[]) => {
      calls.push({ operation: "select", method: "select", args });
      return makeQuery("select");
    }),
    insert: vi.fn((...args: unknown[]) => {
      calls.push({ operation: "insert", method: "insert", args });
      return makeQuery("insert");
    }),
    update: vi.fn((...args: unknown[]) => {
      calls.push({ operation: "update", method: "update", args });
      return makeQuery("update");
    }),
    delete: vi.fn((...args: unknown[]) => {
      calls.push({ operation: "delete", method: "delete", args });
      return makeQuery("delete");
    }),
    execute: vi.fn(async (...args: unknown[]) => {
      calls.push({ operation: "execute", method: "execute", args });
      return consume("execute");
    }),
    transaction: vi.fn(async (callback: (transaction: Db) => unknown) =>
      callback(db as unknown as Db)),
    query: new Proxy({}, {
      get() {
        return {
          findFirst: vi.fn(async () => consume("select")),
          findMany: vi.fn(async () => consume("select")),
        };
      },
    }),
    $client: Object.assign(
      vi.fn(async (...args: unknown[]) => {
        calls.push({ operation: "execute", method: "$client", args });
        return consume("execute");
      }),
      { end: vi.fn(async () => undefined) },
    ),
  } as unknown as Db;

  return {
    db,
    calls,
    remaining: (operation) => queues.get(operation)!.length,
  };
}
