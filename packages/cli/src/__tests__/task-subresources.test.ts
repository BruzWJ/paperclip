import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTaskCommands } from "../commands/client/task.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const COMMENT_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";
const PRODUCT_ID = "77777777-7777-4777-8777-777777777777";
const HOLD_ID = "99999999-9999-4999-8999-999999999999";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LABEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerTaskCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("task subresource commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps canonical task get, title, reassignment, and comment endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["task", "get", TASK_ID]);
    await run(["task", "title", TASK_ID, "--title", "New title"]);
    await run(["task", "reassign", TASK_ID, "--owner-agent-id", COMPANY_ID]);
    await run([
      "task", "comment", TASK_ID,
      "--message", "Please review",
      "--mention-target-agent-id", COMPANY_ID,
      "--mention-ownership-epoch", "3",
    ]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}`],
      ["PATCH", `http://localhost:3100/api/tasks/${TASK_ID}`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/reassign`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/comments`],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      title: "New title",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      ownerAgentId: COMPANY_ID,
      idempotencyKey: expect.any(String),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      message: "Please review",
      idempotencyKey: expect.any(String),
      mention: {
        targetAgentId: COMPANY_ID,
        ownershipEpoch: 3,
      },
    });
  });

  it("sends a persisted reply target without an agent mention", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "task", "comment", TASK_ID,
      "--message", "Additional context",
      "--reply-to-comment-id", COMMENT_ID,
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/tasks/${TASK_ID}/comments`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      message: "Additional context",
      idempotencyKey: expect.any(String),
      mention: null,
      replyToCommentId: COMMENT_ID,
    });
  });

  it("wraps comments, approvals, and marker reads", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "task",
      "comments",
      TASK_ID,
      "--cursor",
      "root-cursor",
      "--limit",
      "10",
      "--entry-limit",
      "4",
    ]);
    await run(["task", "comment:get", TASK_ID, COMMENT_ID]);
    await run(["task", "approvals", TASK_ID]);
    await run(["task", "approval:link", TASK_ID, APPROVAL_ID]);
    await run(["task", "approval:unlink", TASK_ID, APPROVAL_ID]);
    await run(["task", "read", TASK_ID]);
    await run(["task", "unread", TASK_ID]);
    await run(["task", "archive", TASK_ID]);
    await run(["task", "unarchive", TASK_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/comments?cursor=root-cursor&limit=10&entryLimit=4`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/comments/${COMMENT_ID}`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/approvals`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/approvals`],
      ["DELETE", `http://localhost:3100/api/tasks/${TASK_ID}/approvals/${APPROVAL_ID}`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/read`],
      ["DELETE", `http://localhost:3100/api/tasks/${TASK_ID}/read`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/inbox-archive`],
      ["DELETE", `http://localhost:3100/api/tasks/${TASK_ID}/inbox-archive`],
    ]);
  });

  it("wraps document and work product endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["task", "documents", TASK_ID, "--include-system"]);
    await run(["task", "document:get", TASK_ID, "plan"]);
    await run(["task", "document:put", TASK_ID, "plan", "--body", "# Plan", "--title", "Plan"]);
    await run(["task", "document:lock", TASK_ID, "plan"]);
    await run(["task", "document:unlock", TASK_ID, "plan"]);
    await run(["task", "document:revisions", TASK_ID, "plan"]);
    await run(["task", "document:restore", TASK_ID, "plan", APPROVAL_ID]);
    await run(["task", "document:delete", TASK_ID, "plan"]);
    await run(["task", "work-products", TASK_ID]);
    await run([
      "task", "work-product:create", TASK_ID,
      "--payload-json", JSON.stringify({ type: "pull_request", provider: "github", title: "PR", url: "https://example.com/pr/1" }),
    ]);
    await run([
      "task", "work-product:update", PRODUCT_ID,
      "--payload-json", JSON.stringify({ title: "Updated PR" }),
    ]);
    await run(["task", "work-product:delete", PRODUCT_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/documents?includeSystem=true`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan`],
      ["PUT", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan/lock`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan/unlock`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan/revisions`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan/revisions/${APPROVAL_ID}/restore`],
      ["DELETE", `http://localhost:3100/api/tasks/${TASK_ID}/documents/plan`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/work-products`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/work-products`],
      ["PATCH", `http://localhost:3100/api/work-products/${PRODUCT_ID}`],
      ["DELETE", `http://localhost:3100/api/work-products/${PRODUCT_ID}`],
    ]);
  });

  it("wraps tree holds, labels, and attachments", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "paperclip-cli-test-"));
    const filePath = join(tmp, "attachment.txt");
    await writeFile(filePath, "hello", "utf8");
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await run(["task", "tree-state", TASK_ID]);
      await run(["task", "tree-preview", TASK_ID, "--payload-json", JSON.stringify({ mode: "pause" })]);
      await run(["task", "tree-holds", TASK_ID, "--status", "active", "--include-members"]);
      await run(["task", "tree-hold:create", TASK_ID, "--payload-json", JSON.stringify({ mode: "pause", reason: "test" })]);
      await run(["task", "tree-hold:get", TASK_ID, HOLD_ID]);
      await run(["task", "tree-hold:release", TASK_ID, HOLD_ID]);
      await run(["task", "attachments", TASK_ID]);
      await run(["task", "attachment:upload", TASK_ID, "--company-id", COMPANY_ID, "--file", filePath]);
      await run(["task", "attachment:download", ATTACHMENT_ID]);
      await run(["task", "attachment:delete", ATTACHMENT_ID]);
      await run(["task", "label:list", "--company-id", COMPANY_ID]);
      await run(["task", "label:create", "--company-id", COMPANY_ID, "--name", "bug", "--color", "#ff0000"]);
      await run(["task", "label:delete", LABEL_ID]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/tree-control/state`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/tree-control/preview`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/tree-holds?status=active&includeMembers=true`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/tree-holds`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/tree-holds/${HOLD_ID}`],
      ["POST", `http://localhost:3100/api/tasks/${TASK_ID}/tree-holds/${HOLD_ID}/release`],
      ["GET", `http://localhost:3100/api/tasks/${TASK_ID}/attachments`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/tasks/${TASK_ID}/attachments`],
      ["GET", `http://localhost:3100/api/attachments/${ATTACHMENT_ID}/content`],
      ["DELETE", `http://localhost:3100/api/attachments/${ATTACHMENT_ID}`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/labels`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/labels`],
      ["DELETE", `http://localhost:3100/api/labels/${LABEL_ID}`],
    ]);
  });

  it("forwards board authorization and inferred content-type on attachment:upload", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "paperclip-cli-test-"));
    const filePath = join(tmp, "deliverable.html");
    await writeFile(filePath, "<html><body>hi</body></html>", "utf8");
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await run([
        "task", "attachment:upload", TASK_ID,
        "--company-id", COMPANY_ID,
        "--file", filePath,
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/tasks/${TASK_ID}/attachments`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-paperclip-run-id"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer board-token");
    const file = (init.body as FormData).get("file") as File;
    expect(file.type).toBe("text/html");
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
