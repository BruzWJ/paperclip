const readline = require("node:readline");

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
    process.stdout.write("\n");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { supportedMethods: ["getData"] },
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
    send({
      jsonrpc: "2.0",
      method: "log",
      params: {
        level: "info",
        message: "This id-less envelope violates the worker transport.",
      },
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
});
