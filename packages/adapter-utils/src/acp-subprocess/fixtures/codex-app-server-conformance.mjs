#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv[2] !== "app-server") {
  process.stderr.write("controlled Codex fixture requires app-server\n");
  process.exit(64);
}

const tracePath = path.join(
  process.cwd(),
  ".paperclip-codex-app-server-trace.ndjson",
);
const trace = (entry) => {
  fs.appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, "utf8");
};
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const serverControlEnvironmentKey = ["PAPERCLIP", "API", "URL"].join("_");
const respond = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });

trace({
  kind: "startup",
  argv: process.argv.slice(2),
  environment: {
    CODEX_PATH: process.env.CODEX_PATH ?? null,
    CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,
    CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    HOME: process.env.HOME ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
    APPDATA: process.env.APPDATA ?? null,
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? null,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? null,
    SERVER_CONTROL_ENV: process.env[serverControlEnvironmentKey] ?? null,
  },
});

let turnSequence = 0;
const activeTurns = new Map();
const model = {
  id: "gpt-5.6",
  displayName: "gpt-5.6",
  description: "Controlled conformance model",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Low" },
    { reasoningEffort: "high", description: "High" },
  ],
  defaultReasoningEffort: "high",
  isDefault: true,
  inputModalities: ["text"],
  supportsPersonality: false,
  supportedServiceTiers: [],
};

const publishUsage = (threadId, turnId) => {
  const tokenCount = {
    totalTokens: 9,
    inputTokens: 6,
    cachedInputTokens: 1,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  };
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      last: tokenCount,
      total: tokenCount,
      modelContextWindow: 128,
    },
  });
};

const completedTurn = (threadId, turnId) => {
  notify("thread/name/updated", {
    threadId,
    threadName: "Controlled conformance session",
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: `message-${turnId}`,
    delta: `native-response-${turnId}`,
  });
  publishUsage(threadId, turnId);
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  });
  activeTurns.delete(threadId);
};

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  const request = JSON.parse(line);
  trace({ kind: "request", method: request.method, params: request.params });
  const id = request.id;
  switch (request.method) {
    case "initialize":
      respond(id, {
        userAgent: "paperclip-controlled-codex",
        [["codex", "Home"].join("")]: path.join(
          process.cwd(),
          ".controlled-codex-home",
        ),
      });
      return;
    case "account/read":
      respond(id, { account: null, requiresOpenaiAuth: false });
      return;
    case "skills/extraRoots/set":
      respond(id, {});
      return;
    case "skills/list":
      respond(id, { data: [], errors: [] });
      return;
    case "model/list":
      respond(id, { data: [model], nextCursor: null });
      return;
    case "config/read":
      respond(id, { config: {}, layers: [] });
      return;
    case "thread/start":
      respond(id, {
        thread: { id: "native-new-session" },
        model: model.id,
        reasoningEffort: model.defaultReasoningEffort,
        modelProvider: "openai",
        serviceTier: null,
      });
      return;
    case "thread/resume":
      respond(id, {
        thread: { id: request.params.threadId },
        model: model.id,
        reasoningEffort: model.defaultReasoningEffort,
        modelProvider: "openai",
        serviceTier: null,
      });
      return;
    case "thread/goal/get":
      respond(id, { goal: null });
      return;
    case "turn/start": {
      const turnId = `native-turn-${++turnSequence}`;
      activeTurns.set(request.params.threadId, turnId);
      respond(id, { turn: { id: turnId } });
      const promptText = request.params.input?.[0]?.text ?? "";
      if (!promptText.includes("wait-for-cancel")) {
        queueMicrotask(() => completedTurn(request.params.threadId, turnId));
      }
      return;
    }
    case "turn/interrupt": {
      respond(id, {});
      const threadId = request.params.threadId;
      const turnId = activeTurns.get(threadId);
      if (turnId) {
        queueMicrotask(() => {
          publishUsage(threadId, turnId);
          notify("turn/completed", {
            threadId,
            turn: {
              id: turnId,
              items: [],
              itemsView: "notLoaded",
              status: "interrupted",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          });
          activeTurns.delete(threadId);
        });
      }
      return;
    }
    case "thread/unsubscribe":
      respond(id, {});
      return;
    default:
      send({
        id,
        error: { code: -32601, message: `unsupported fixture method ${request.method}` },
      });
  }
});

lines.on("close", () => process.exit(0));
