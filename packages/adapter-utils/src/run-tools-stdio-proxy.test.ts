import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_TOOLS_INGRESS_ORDINAL_HEADER,
  RUN_TOOLS_STDIO_PROXY_SOURCE,
} from "./run-tools-stdio-proxy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("run-tools stdio proxy", () => {
  it("stamps source ingress privately, overlaps calls, preserves barriers, and drains before cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-run-tools-"));
    temporaryDirectories.push(directory);
    const proxyPath = join(directory, "proxy.mjs");
    const configPath = join(directory, "config.json");
    await writeFile(proxyPath, RUN_TOOLS_STDIO_PROXY_SOURCE, {
      mode: 0o700,
    });

    const events: string[] = [];
    const calls: Array<{
      id: unknown;
      ordinal: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        events.push("delete");
        response.statusCode = 204;
        response.end();
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw) as Record<string, unknown>;
      const id = body.id;
      const method = body.method;
      if (method === "tools/call") {
        const ordinal = request.headers[
          RUN_TOOLS_INGRESS_ORDINAL_HEADER
        ];
        calls.push({
          id,
          ordinal: Array.isArray(ordinal) ? ordinal[0] : ordinal,
          body,
        });
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        events.push(`call-start:${String(id)}`);
        await delay(id === "fast" ? 5 : id === "new" ? 20 : 70);
        activeCalls -= 1;
        events.push(`call-end:${String(id)}`);
      } else {
        events.push(`operation:${String(method)}:active=${activeCalls}`);
      }
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (method === "initialize") {
        response.setHeader("mcp-session-id", "private-session");
      }
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { echoed: id },
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test address");
    }
    await writeFile(configPath, JSON.stringify({
      kind: "paperclip.run-tools/v1",
      endpoint: `http://127.0.0.1:${address.port}/run-tools`,
      bearer: "private-bearer",
    }));

    const child = spawn(process.execPath, [proxyPath, configPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const messages = [
      { jsonrpc: "2.0", id: "init", method: "initialize" },
      {
        jsonrpc: "2.0",
        id: "slow",
        method: "tools/call",
        params: { name: "mention_agent", arguments: { message: "one" } },
      },
      {
        jsonrpc: "2.0",
        id: "fast",
        method: "tools/call",
        params: { name: "mention_agent", arguments: { message: "two" } },
      },
      {
        jsonrpc: "2.0",
        id: "slow",
        method: "tools/call",
        params: { name: "mention_agent", arguments: { message: "one" } },
      },
      {
        jsonrpc: "2.0",
        id: "new",
        method: "tools/call",
        params: { name: "read_issue_comments", arguments: {} },
      },
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
    ];
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    const [exitCode] = await once(child, "close");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(maximumActiveCalls).toBeGreaterThan(1);
    expect(
      calls
        .filter((call) => call.id === "slow")
        .map((call) => call.ordinal),
    ).toEqual(["0", "0"]);
    expect(calls.find((call) => call.id === "fast")?.ordinal).toBe("1");
    expect(calls.find((call) => call.id === "new")?.ordinal).toBe("2");
    expect(calls.map((call) => call.body)).toEqual(
      expect.arrayContaining(messages.slice(1, 5)),
    );
    expect(JSON.stringify(calls)).not.toContain("ingressOrdinal");
    expect(events).toContain("operation:initialize:active=0");
    expect(events).toContain("operation:tools/list:active=0");
    expect(events.at(-1)).toBe("delete");

    const responses = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string });
    expect(responses[0]?.id).toBe("init");
    expect(responses.findIndex((response) => response.id === "fast"))
      .toBeLessThan(
        responses.findIndex((response) => response.id === "slow"),
      );
    expect(responses.at(-1)?.id).toBe("list");
    expect(responses.map((response) => response.id)).toEqual(
      expect.arrayContaining(["init", "slow", "fast", "new", "list"]),
    );
  });
});
