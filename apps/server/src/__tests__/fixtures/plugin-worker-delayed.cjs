const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
let draining = false;
const activeRequests = new Set();

function rejectDraining(id) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "Worker is draining",
    },
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "shutdown") {
    if (draining) {
      rejectDraining(message.id);
      return;
    }
    draining = true;
    void Promise.allSettled([...activeRequests]).then(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {},
      });
      setImmediate(() => process.exit(0));
    });
    return;
  }

  if (draining) {
    rejectDraining(message.id);
    return;
  }

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        supportedMethods: ["getData"],
      },
    });
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

  if (method === "getData") {
    const delayMs = Number(message.params?.params?.delayMs ?? 0);
    const request = new Promise((resolve) => {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          },
        });
        resolve();
      }, delayMs);
    });
    activeRequests.add(request);
    void request.finally(() => activeRequests.delete(request));
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
