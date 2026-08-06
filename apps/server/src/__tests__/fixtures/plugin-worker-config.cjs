const readline = require("node:readline");

let currentConfig = {};
let initializeRequestId = null;
const CONFIG_REQUEST_ID = "plugin-worker-config:get";

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
      id: CONFIG_REQUEST_ID,
      method: "config.get",
      params: {},
    });
    return;
  }

  if (message.id === CONFIG_REQUEST_ID && method === null) {
    currentConfig = message.result ?? {};
    const supportedMethods = ["getData"];
    if (currentConfig.advertiseBeforePrompt === true) {
      supportedMethods.push("beforePrompt");
    }
    if (Array.isArray(currentConfig.extraSupportedMethods)) {
      supportedMethods.push(...currentConfig.extraSupportedMethods);
    }
    const result = { supportedMethods };
    if (currentConfig.includeUnexpectedInitializeField === true) {
      result.unexpected = true;
    }
    send({
      jsonrpc: "2.0",
      id: initializeRequestId,
      result,
    });
    initializeRequestId = null;
    return;
  }

  if (method === "getData") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: currentConfig,
    });
    return;
  }

  if (method === "health") {
    if (currentConfig.rejectHealth === true) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: "Health is not implemented",
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: Object.prototype.hasOwnProperty.call(currentConfig, "healthResult")
        ? currentConfig.healthResult
        : { status: "ok" },
    });
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
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
