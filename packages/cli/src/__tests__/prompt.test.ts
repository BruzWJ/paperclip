import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeContext } from "../client/context.js";
import { runBoardPrompt } from "../commands/client/prompt.js";

const ORIGINAL_ENV = { ...process.env };

function createTempContextPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-prompt-"));
  return path.join(dir, "context.json");
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    name: "Worker",
    urlKey: "worker",
    status: "active",
    ...overrides,
  };
}

describe("board prompt", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("creates an owned task through the canonical task route", async () => {
    const prompt = " \tInvestigate queue lag\r\nliteral\\n and literal\\r\t \n";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agent()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "task-1",
        companyId: "22222222-2222-4222-8222-222222222222",
        title: "Investigate queue lag",
        lifecycleStatus: "open",
        boardPresentationStatus: "todo",
        priority: "medium",
        assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardPrompt("worker", prompt, {
      apiBase: "http://localhost:3100",
      apiKey: "board-token",
      companyId: "22222222-2222-4222-8222-222222222222",
    });

    expect(result.actor).toBe("board");
    expect(result.mode).toBe("task");
    expect(result.agent.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3100/api/agents/worker?companyId=22222222-2222-4222-8222-222222222222",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://localhost:3100/api/companies/22222222-2222-4222-8222-222222222222/tasks",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      request: prompt,
      ownerAgentId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: expect.any(String),
      title: "Investigate queue lag",
    });
  });

  it("adds a board-authored prompt comment through the canonical comment route", async () => {
    const prompt = " \tFollow up on queue lag\r\nliteral\\n and literal\\r\t \n";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agent()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "task-1",
        companyId: "22222222-2222-4222-8222-222222222222",
        ownerAgentId: "11111111-1111-4111-8111-111111111111",
        ownershipEpoch: 3,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        comment: {
          id: "comment-1",
          taskId: "task-1",
          body: "Follow up on queue lag",
        },
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardPrompt("worker", prompt, {
      apiBase: "http://localhost:3100",
      apiKey: "board-token",
      companyId: "22222222-2222-4222-8222-222222222222",
      task: "task-1",
    });

    expect(result.actor).toBe("board");
    expect(result.mode).toBe("comment");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/tasks/task-1");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3100/api/tasks/task-1/comments");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      message: prompt,
      idempotencyKey: expect.any(String),
      mention: {
        targetAgentId: "11111111-1111-4111-8111-111111111111",
        ownershipEpoch: 3,
      },
    });
  });
});
