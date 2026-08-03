import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createHostClientHandlers,
  type HostServices,
} from "../src/host-client-factory.js";
import {
  createRequest,
  createErrorResponse,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type JsonRpcResponse,
  type PluginInvocationContext,
} from "../src/protocol.js";
import { isWorkerEntrypoint, startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("isWorkerEntrypoint", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createTempRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sdk-worker-"));
    tempRoots.push(tempRoot);
    return tempRoot;
  }

  it("matches an entrypoint reached through a symlinked directory", () => {
    const tempRoot = createTempRoot();
    const realDir = path.join(tempRoot, "real");
    const linkDir = path.join(tempRoot, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, "dir");

    const workerPath = path.join(realDir, "worker.js");
    fs.writeFileSync(workerPath, "");

    expect(
      isWorkerEntrypoint(
        path.join(linkDir, "worker.js"),
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(true);
  });

  it("does not match a different entrypoint", () => {
    const tempRoot = createTempRoot();
    const workerPath = path.join(tempRoot, "worker.js");
    const otherPath = path.join(tempRoot, "other.js");
    fs.writeFileSync(workerPath, "");
    fs.writeFileSync(otherPath, "");

    expect(
      isWorkerEntrypoint(
        otherPath,
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(false);
  });
});

describe("worker performAction context", () => {
  it("rejects invalid actors before the handler and trusts the decoded actor company", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const inspect = vi.fn(async (params: Record<string, unknown>, context: unknown) => ({
      paramsCompanyId: params.companyId,
      actor: (context as { actor: unknown }).actor,
      companyId: (context as { companyId: unknown }).companyId,
    }));
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("inspect", inspect);
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(Object.assign(
              new Error(response.error.message),
              { code: response.error.code },
            ));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "paperclip.test-worker-context",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Worker Context Test",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });

      const invalidActors: unknown[] = [
        undefined,
        null,
        {},
        { type: "system" },
        { type: "system", companyId: "" },
        { type: "system", companyId: null, userId: "mixed" },
        { type: "user", companyId: "company-a", userId: " " },
        {
          type: "user",
          companyId: "company-a",
          userId: "user-a",
          agentId: "mixed",
        },
        {
          type: "agent",
          companyId: "company-a",
          agentId: "agent-a",
          runId: "",
        },
        {
          type: "agent",
          companyId: "company-a",
          agentId: "agent-a",
          runId: "run-a",
          userId: "mixed",
        },
      ];
      for (const actorContext of invalidActors) {
        await expect(callWorker("performAction", {
          key: "inspect",
          params: {},
          ...(actorContext === undefined ? {} : { actorContext }),
        })).rejects.toMatchObject({
          code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
          message: expect.stringContaining("actorContext"),
        });
      }
      expect(inspect).not.toHaveBeenCalled();

      await expect(callWorker("performAction", {
        key: "inspect",
        params: { companyId: "spoofed-company" },
        actorContext: {
          type: "system",
          companyId: null,
        },
      })).resolves.toEqual({
        actor: {
          type: "system",
          companyId: null,
        },
        companyId: null,
      });
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker invocation scope propagation", () => {
  it("keeps overlapping company scopes local to each getData invocation", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedInvocationIds: string[] = [];
    const invocationCompanies = new Map([
      ["invocation-a", "company-a"],
      ["invocation-b", "company-b"],
    ]);
    let releaseCompanyA: (() => void) | null = null;
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("probe", async (params) => {
          if (params.label === "a") {
            await new Promise<void>((resolve) => {
              releaseCompanyA = resolve;
            });
          }
          const company = await ctx.companies.get(String(params.requestedCompanyId));
          return { label: params.label, company };
        });
      },
    });

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }

      if (!isJsonRpcRequest(message)) return;
      if (message.method !== "companies.get") return;

      const invocationId = (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "";
      const requestedCompanyId = (message.params as { companyId?: string }).companyId;
      const allowedCompanyId = invocationCompanies.get(invocationId);
      nestedInvocationIds.push(invocationId);
      if (requestedCompanyId !== allowedCompanyId) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
          `requested company "${requestedCompanyId}" but invocation "${invocationId}" is scoped to "${allowedCompanyId}"`,
        )));
        return;
      }

      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: requestedCompanyId,
      })));

      if (invocationId === "invocation-b") {
        releaseCompanyA?.();
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.scope-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Scope test",
          description: "Scope test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["companies.read"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      const companyARequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-a",
          params: { label: "a", requestedCompanyId: "company-b" },
        },
        { id: "invocation-a", scope: { companyId: "company-a" } },
      );
      const companyAExpectation = expect(companyARequest).rejects.toThrow(
        /requested company "company-b"/,
      );
      const companyBRequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-b",
          params: { label: "b", requestedCompanyId: "company-b" },
        },
        { id: "invocation-b", scope: { companyId: "company-b" } },
      );

      await expect(companyBRequest).resolves.toEqual({
        label: "b",
        company: { id: "company-b" },
      });
      await companyAExpectation;

      expect(nestedInvocationIds).toEqual(["invocation-b", "invocation-a"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker plugin run-context bridge", () => {
  it("blocks captured installation issue APIs during executeTool while run issues use the exact opaque handle", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedCalls: Array<{
      method: string;
      params: unknown;
      invocationId: string | undefined;
    }> = [];
    let nextRequestId = 1;
    const ordinaryIssueList = vi.fn(async () => []);
    const readIssueComments = vi.fn(async () => ({
      items: [{ id: "comment-a", body: "Dial-authorized comment." }],
      nextCursor: null,
    }));
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.run-context-test",
      capabilities: ["issues.read"],
      services: {
        issues: { list: ordinaryIssueList },
        runIssues: { readIssueComments },
      } as unknown as HostServices,
    });
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "inspect",
          {
            displayName: "Inspect",
            description: "Inspect the opaque runtime facade",
            parametersSchema: { type: "object", properties: {} },
          },
          async (_params, runContext) => {
            let ordinaryIssueError: { code: number | null; message: string } | null = null;
            try {
              await ctx.issues.list({ companyId: "company-a" });
            } catch (error) {
              ordinaryIssueError = {
                code: typeof (error as { code?: unknown })?.code === "number"
                  ? (error as { code: number }).code
                  : null,
                message: error instanceof Error ? error.message : String(error),
              };
            }
            const comments = await runContext.issues.readIssueComments();
            return {
              content: "ok",
              data: {
                contextKeys: Object.keys(runContext).sort(),
                handle: runContext.handle,
                ordinaryIssueError,
                comments,
              },
            };
          },
        );
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(
      method: string,
      params: unknown,
      invocation?: PluginInvocationContext,
    ) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage({
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      }));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      nestedCalls.push({
        method: message.method,
        params: message.params,
        invocationId: message.paperclipInvocationId,
      });
      const handler = (
        handlers as Record<
          string,
          (params: unknown, context: unknown) => Promise<unknown>
        >
      )[message.method];
      if (!handler) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `No host handler for "${message.method}"`,
        )));
        return;
      }
      const context = message.paperclipInvocationId === "invocation-run"
        ? {
          invocationScope: {
            companyId: "company-a",
            pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
          },
        }
        : { invalidInvocationScope: true };
      void handler(message.params, context).then(
        (result) => {
          hostToWorker.write(serializeMessage(createSuccessResponse(message.id, result)));
        },
        (error: unknown) => {
          const code = typeof (error as { code?: unknown })?.code === "number"
            ? (error as { code: number }).code
            : PLUGIN_RPC_ERROR_CODES.UNKNOWN;
          hostToWorker.write(serializeMessage(createErrorResponse(
            message.id,
            code,
            error instanceof Error ? error.message : String(error),
          )));
        },
      );
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.run-context-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Run context test",
          description: "Run context test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["agent.tools.register", "issues.read"],
          entrypoints: { worker: "dist/worker.js" },
          tools: [{
            name: "inspect",
            displayName: "Inspect",
            description: "Inspect",
            parametersSchema: { type: "object", properties: {} },
          }],
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      await expect(callWorker(
        "executeTool",
        {
          toolName: "inspect",
          parameters: {},
          runContextHandle: "pc_plugin_ctx_v1_exact",
        },
        {
          id: "invocation-run",
          scope: {
            companyId: "company-a",
            pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
          },
        },
      )).resolves.toEqual({
        content: "ok",
        data: {
          contextKeys: ["handle", "issues"],
          handle: "pc_plugin_ctx_v1_exact",
          ordinaryIssueError: {
            code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
            message: expect.stringContaining(
              "installation issue control plane is unavailable while serving an agent run",
            ),
          },
          comments: {
            items: [{ id: "comment-a", body: "Dial-authorized comment." }],
            nextCursor: null,
          },
        },
      });
      expect(nestedCalls).toContainEqual({
        method: "issues.list",
        params: { companyId: "company-a" },
        invocationId: "invocation-run",
      });
      expect(nestedCalls).toContainEqual({
        method: "run.issues.readIssueComments",
        params: { runContextHandle: "pc_plugin_ctx_v1_exact" },
        invocationId: "invocation-run",
      });
      expect(ordinaryIssueList).not.toHaveBeenCalled();
      expect(readIssueComments).toHaveBeenCalledOnce();
      expect(readIssueComments).toHaveBeenCalledWith({
        runContextHandle: "pc_plugin_ctx_v1_exact",
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker issue mutation bridge", () => {
  it("replays each exact mutation request after a lost response without supplying an operation identity", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const hostCalls: Array<{ id: unknown; method: string; params: unknown; line: string }> = [];
    const mutationAttempts = new Map<string, number>();
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("mutations", async () => {
          const created = await ctx.issues.create({
            companyId: "company-1",
            request: "Create exact plugin work.",
            ownerAgentId: "agent-1",
            callbackKey: "creator",
            callbackVersion: "1",
          });
          const messaged = await ctx.issues.update(
            "issue-1",
            { kind: "message", message: "One creator message." },
            "company-1",
          );
          const reassigned = await ctx.issues.update(
            "issue-1",
            { kind: "reassign", ownerAgentId: "agent-2" },
            "company-1",
          );
          const withdrawn = await ctx.issues.withdraw(
            "issue-1",
            "The plugin no longer needs this work.",
            "company-1",
          );
          return { created, messaged, reassigned, withdrawn };
        });
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
      rpcTimeoutMs: 20,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      hostCalls.push({
        id: message.id,
        method: message.method,
        params: message.params,
        line,
      });
      const updateKind = message.method === "issues.update"
        ? (message.params as { input: { kind: string } }).input.kind
        : "";
      const mutationKey = `${message.method}:${updateKind}`;
      const attempt = (mutationAttempts.get(mutationKey) ?? 0) + 1;
      mutationAttempts.set(mutationKey, attempt);
      if (attempt === 1) return;
      if (message.method === "issues.withdraw") {
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
          operationId: "host-operation-1",
          issue: { id: "issue-1", status: "cancelled" },
          retried: true,
        })));
        return;
      }
      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: "issue-1",
        companyId: "company-1",
      })));
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.withdraw-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Withdrawal test",
          description: "Withdrawal test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["issues.withdraw"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      await expect(callWorker("getData", {
        key: "mutations",
        params: {},
      })).resolves.toMatchObject({
        created: { id: "issue-1" },
        messaged: { id: "issue-1" },
        reassigned: { id: "issue-1" },
        withdrawn: {
          operationId: "host-operation-1",
          retried: true,
        },
      });
      expect(hostCalls).toHaveLength(8);
      for (let index = 0; index < hostCalls.length; index += 2) {
        expect(hostCalls[index + 1]).toEqual(hostCalls[index]);
      }
      const withdrawal = hostCalls.find(
        ({ method }) => method === "issues.withdraw",
      );
      expect(withdrawal).toMatchObject({
        params: {
          issueId: "issue-1",
          companyId: "company-1",
          message: "The plugin no longer needs this work.",
        },
      });
      expect(withdrawal?.params).not.toHaveProperty("operationId");
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});
