import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  PostgresTaskExecutionAcpEventRejected,
  canonicalPaperclipMcpToolName,
  createPostgresTaskExecutionAcpEventSink,
  projectedAcpToolName,
} from "./task-execution-acp-events-postgres.js";

describe("ACP Session projection lock order", () => {
  it("locks company, task, and Session before the canonical run", async () => {
    const order: string[] = [];
    const lockSql: string[] = [];
    const dialect = new PgDialect();
    const stop = new Error("stop after observing run lock");
    let rootLock = 0;
    const transaction = {
      execute: vi.fn(async (query: unknown) => {
        lockSql.push(dialect.sqlToQuery(query as never).sql);
        rootLock += 1;
        if (rootLock === 1) {
          order.push("company");
          return [{ id: "company-1" }];
        }
        if (rootLock === 2) {
          order.push("task");
          return [{ id: "task-1" }];
        }
        order.push("session");
        return [{ projectedEventSeq: 0 }];
      }),
    };
    const sink = createPostgresTaskExecutionAcpEventSink({
      database: {
        transaction: vi.fn(
          async (work: (tx: typeof transaction) => unknown) =>
            work(transaction),
        ),
      } as never,
      runService: {
        lockRun: vi.fn(async () => {
          order.push("run");
          throw stop;
        }),
      },
    });

    await expect(sink.publish({
      prompt: {
        companyId: "company-1",
        taskId: "task-1",
        sessionId: "session-1",
      } as never,
      capability: {} as never,
      event: {} as never,
      redactor: {} as never,
    })).rejects.toBe(stop);
    expect(order).toEqual(["company", "task", "session", "run"]);
    expect(lockSql).toHaveLength(3);
    expect(lockSql[0]).toMatch(/from "companies"[\s\S]*for key share/i);
    expect(lockSql[1]).toMatch(/from "tasks"[\s\S]*for no key update/i);
    expect(lockSql[2]).toMatch(/from task_sessions[\s\S]*for update/i);
  });
});

describe("canonical Paperclip MCP tool identity", () => {
  it("uses only the exact Paperclip server/tool envelope", () => {
    expect(canonicalPaperclipMcpToolName({
      server: "paperclip",
      tool: "acme.search__find_record",
      arguments: { query: "status" },
    })).toBe("acme.search__find_record");

    expect(canonicalPaperclipMcpToolName({
      server: "external",
      tool: "acme.search__find_record",
      arguments: {},
    })).toBeNull();
  });

  it("does not treat another server's tool identity as Paperclip identity", () => {
    expect(canonicalPaperclipMcpToolName({
      server: "external",
      tool: "acme.search__find_record",
      arguments: {},
    })).toBeNull();
    expect(projectedAcpToolName({
      server: "external",
      tool: "acme.search__find_record",
      arguments: {},
    }, "Find record")).toBe("provider-tool:Find record");
  });

  it("fails closed for a Paperclip envelope without exact identity", () => {
    expect(() => canonicalPaperclipMcpToolName({
      server: "paperclip",
      tool: "acme.search__find_record",
      arguments: {},
      displayAlias: "search",
    })).toThrow(PostgresTaskExecutionAcpEventRejected);
  });
});
