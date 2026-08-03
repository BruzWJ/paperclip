/**
 * Dependency-free Node entrypoint materialized beside one attempt-scoped
 * run-tools secret. Provider CLIs see only the stdio command and target-local
 * file paths; the endpoint and bearer never enter their argv or environment.
 */
export const RUN_TOOLS_INGRESS_ORDINAL_HEADER =
  "x-paperclip-run-tools-ingress-ordinal";

export const RUN_TOOLS_STDIO_PROXY_SOURCE = `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const configPath = process.argv[2];

function failStartup() {
  process.stderr.write("Paperclip run-tools proxy could not start.\\n");
  process.exit(78);
}

let config;
try {
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  const keys = Object.keys(parsed).sort();
  if (
    keys.join("\\n") !== ["bearer", "endpoint", "kind"].join("\\n") ||
    parsed.kind !== "paperclip.run-tools/v1" ||
    typeof parsed.endpoint !== "string" ||
    parsed.endpoint.length === 0 ||
    typeof parsed.bearer !== "string" ||
    parsed.bearer.length === 0
  ) {
    failStartup();
  }
  config = parsed;
} catch {
  failStartup();
}

let sessionId = null;

function emit(value) {
  const text =
    typeof value === "string" ? value.trim() : JSON.stringify(value);
  if (text.length > 0) process.stdout.write(text + "\\n");
}

function requestId(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "id")
      ? value.id
      : null
  );
}

function requestMethod(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.method === "string"
    ? value.method
    : null;
}

function callIdentity(value) {
  const id = requestId(value);
  if (typeof id !== "string" && typeof id !== "number") return null;
  return typeof id + "\\0" + String(id);
}

function emitFailure(id) {
  emit({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "Paperclip run-tools proxy request failed",
    },
  });
}

function emitSse(text) {
  let data = [];
  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join("\\n").trim();
    data = [];
    if (payload && payload !== "[DONE]") emit(payload);
  };
  for (const line of text.split(/\\r?\\n/)) {
    if (line.length === 0) {
      flush();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();
}

async function forward(line, ingressOrdinal) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    emitFailure(null);
    return;
  }
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + config.bearer,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(ingressOrdinal === null
          ? {}
          : {
              "x-paperclip-run-tools-ingress-ordinal":
                String(ingressOrdinal),
            }),
      },
      body: line,
    });
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) sessionId = nextSessionId;
    if (!response.ok) {
      emitFailure(requestId(message));
      return;
    }
    if (response.status === 202 || response.status === 204) return;
    const body = await response.text();
    if (!body.trim()) return;
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      emitSse(body);
    } else {
      emit(body);
    }
  } catch {
    emitFailure(requestId(message));
  }
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
const inFlight = new Set();
const ingressByCallIdentity = new Map();
let nextIngressOrdinal = 0;

async function awaitInFlight() {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function launchCall(line, message) {
  const identity = callIdentity(message);
  let ingressOrdinal = identity === null
    ? nextIngressOrdinal++
    : ingressByCallIdentity.get(identity);
  if (ingressOrdinal === undefined) {
    ingressOrdinal = nextIngressOrdinal++;
    ingressByCallIdentity.set(identity, ingressOrdinal);
  }
  const task = forward(line, ingressOrdinal);
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
}

for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    await awaitInFlight();
    await forward(line, null);
    continue;
  }
  if (requestMethod(message) === "tools/call") {
    launchCall(line, message);
    continue;
  }
  // Initialization, discovery, notifications, ping/control, and any future
  // non-call operation are barriers around the concurrently forwarded calls.
  await awaitInFlight();
  await forward(line, null);
}
await awaitInFlight();

if (sessionId) {
  try {
    await fetch(config.endpoint, {
      method: "DELETE",
      headers: {
        authorization: "Bearer " + config.bearer,
        "mcp-session-id": sessionId,
      },
    });
  } catch {
    // Session cleanup is best effort; the attempt-scoped bearer is revoked by
    // the Paperclip run boundary independently.
  }
}
`;
