const readline = require("node:readline");

let parentRequestId = null;
let parentInvocationId = null;
let replayCount = 0;
const operationIds = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendWithdrawal(id) {
  send({
    jsonrpc: "2.0",
    id,
    method: "issues.withdraw",
    params: {
      issueId: "issue-1",
      companyId: "company-1",
      message: "Withdraw this exact issue.",
    },
    ...(parentInvocationId
      ? { paperclipInvocationId: parentInvocationId }
      : {}),
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id === "withdraw-replay") {
    operationIds.push(message.result.operationId);
    replayCount += 1;
    if (replayCount === 1) {
      sendWithdrawal("withdraw-replay");
    } else {
      sendWithdrawal("withdraw-distinct");
    }
    return;
  }

  if (message.id === "withdraw-distinct") {
    operationIds.push(message.result.operationId);
    send({
      jsonrpc: "2.0",
      id: parentRequestId,
      result: { operationIds },
    });
    return;
  }

  const method = message && typeof message.method === "string"
    ? message.method
    : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["getData"],
      },
    });
    return;
  }

  if (method === "getData") {
    parentRequestId = message.id;
    parentInvocationId = message.paperclipInvocation?.id ?? null;
    sendWithdrawal("withdraw-replay");
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
