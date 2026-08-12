import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBoardPrompt } from "../commands/client/prompt.js";

const ORIGINAL_ENV = { ...process.env };
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Worker",
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
        id: TASK_ID,
        companyId: COMPANY_ID,
        title: "Investigate queue lag",
        lifecycleStatus: "open",
        boardPresentationStatus: "todo",
        priority: "medium",
        assigneeAgentId: AGENT_ID,
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardPrompt(AGENT_ID, prompt, {
      apiBase: "http://localhost:3100",
      apiKey: "board-token",
      companyId: COMPANY_ID,
    });

    expect(result.actor).toBe("board");
    expect(result.mode).toBe("task");
    expect(result.agent.id).toBe(AGENT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/agents/${AGENT_ID}`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/tasks`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      request: prompt,
      ownerAgentId: AGENT_ID,
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
        id: TASK_ID,
        companyId: COMPANY_ID,
        ownerAgentId: AGENT_ID,
        ownershipEpoch: 3,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        comment: {
          id: "comment-1",
          taskId: TASK_ID,
          body: "Follow up on queue lag",
        },
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardPrompt(AGENT_ID, prompt, {
      apiBase: "http://localhost:3100",
      apiKey: "board-token",
      companyId: COMPANY_ID,
      task: TASK_ID,
    });

    expect(result.actor).toBe("board");
    expect(result.mode).toBe("comment");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/tasks/${TASK_ID}`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://localhost:3100/api/tasks/${TASK_ID}/comments`);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      message: prompt,
      idempotencyKey: expect.any(String),
      mention: {
        targetAgentId: AGENT_ID,
        ownershipEpoch: 3,
      },
    });
  });
});
