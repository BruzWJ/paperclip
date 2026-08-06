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
        accept: "application/json",
        authorization: "Bearer " + config.bearer,
        "content-type": "application/json",
        ...(ingressOrdinal === null
          ? {}
          : {
              "x-paperclip-run-tools-ingress-ordinal":
                String(ingressOrdinal),
            }),
      },
      body: line,
    });
    const body = await response.text();
    if (!body.trim()) {
      if (!response.ok) emitFailure(requestId(message));
      return;
    }
    try {
      const parsed = JSON.parse(body);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        parsed.jsonrpc !== "2.0"
      ) {
        emitFailure(requestId(message));
        return;
      }
      emit(parsed);
    } catch {
      emitFailure(requestId(message));
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
  if (requestMethod(message) === "notifications/initialized") {
    await awaitInFlight();
    continue;
  }
  if (requestMethod(message) === "ping") {
    await awaitInFlight();
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      emit({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    continue;
  }
  // Initialization and discovery are barriers around concurrent calls.
  await awaitInFlight();
  await forward(line, null);
}
await awaitInFlight();
`;
