const readline = require("node:readline");

let initializeRequestId = null;
const LOG_REQUEST_ID = "plugin-worker-log:initialize";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    initializeRequestId = message.id;
    send({
      jsonrpc: "2.0",
      id: LOG_REQUEST_ID,
      method: "log",
      params: {
        level: "info",
        message: "Worker initialized",
        meta: { phase: "setup" },
      },
    });
    return;
  }

  if (message.id === LOG_REQUEST_ID && method === null) {
    send({
      jsonrpc: "2.0",
      id: initializeRequestId,
      result: { supportedMethods: [] },
    });
    initializeRequestId = null;
    return;
  }

  if (method === "health") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { status: "ok" },
    });
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: null,
    });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});
