# AgentMemory plugin

First-party Paperclip adapter for a separately hosted
[`@agentmemory/agentmemory`](https://www.npmjs.com/package/@agentmemory/agentmemory)
service. Paperclip captures canonical work automatically and exposes four
read-only recall tools through the normal ACP tool gateway. Agents never write
memory directly, and memory content is not inserted into user or system
messages.

## Memory matrix

| Reach | Agent-private memory | Shared memory |
| --- | --- | --- |
| Current or otherwise visible issue | `read_issue_agent_memory(issueId, query)` — current agent + issue | `read_issue_shared_memory(issueId, query)` — company + issue |
| Company-wide | `read_company_agent_memory(query)` — current agent + company | `read_company_shared_memory(query)` — company |

Sub-issues and other company issues use the same two issue tools. Agents first
obtain an issue ID through Paperclip's ordinary issue tools. Paperclip derives
memory reach from the existing context-access matrix:

- The active issue is always reachable.
- Descendants are reachable with `list_sub_issues` or `list_company_issues`.
- Other issues and both company-wide partitions require
  `list_company_issues`.
- Cross-company access is always rejected by the host.

There is no separate per-agent memory setting and no memory-specific Paperclip
HTTP endpoint.

## Automatic updates

| Trigger | Partitions updated | Canonical input |
| --- | --- | --- |
| Agent run reaches a terminal state | issue-agent and company-agent | Provider-safe user turns, assistant text, and bounded completed/failed non-memory tool calls from the run trace |
| Issue comment is committed, or a run finishes with projected comments | issue-shared and company-shared | Canonical issue comment bodies, including board comments and agent output projected as comments |

Reasoning, provider metadata, secrets removed by Paperclip's canonical
projection, and AgentMemory recall calls/results are excluded. A projected
assistant result can intentionally exist in both the agent-private trace and
the shared issue-comment history.

Capture follows Paperclip's generic plugin event semantics: delivery is
in-process, eventually consistent, and currently best-effort rather than a
durable outbox. AgentMemory sanitizes observations on ingestion, but comment
bodies cross the administrator-configured connection before that sanitization.

## Security boundary

The plugin hashes every Paperclip company, issue, agent, and source identifier
before sending AgentMemory project/session coordinates. Paperclip remains the
authorization boundary: each tool call is tied to the exact active run,
bound to the installed plugin in the prompt-capability call ledger, and
revalidated against company enablement and the context-access matrix. Calls use
the direct plugin runtime and remain auditable; they are not company-tool
catalog entries.

Hashed project names are logical partitioning, not a hard storage tenant
boundary inside AgentMemory. For hard multi-company storage isolation, run a
separate AgentMemory service and data directory for each company and configure
that company's plugin settings with its own URL and secret.

The plugin requests elevated generic capabilities because it is trusted
infrastructure:

- direct tools available to all agents in enabled companies;
- canonical run-context and redacted runtime-record reads;
- outbound access to an operator-hosted private-network service;
- secret-reference resolution.

Only an administrator should install or approve this plugin.

## Configure

Start AgentMemory separately. Version `0.9.28` is the locally verified API
contract for this adapter.

```bash
AGENTMEMORY_SECRET='<strong-random-secret>' \
  npx -y @agentmemory/agentmemory@0.9.28 \
  --data-dir /absolute/path/to/company-agentmemory-data
```

In the plugin settings for each Paperclip company, set:

- `baseUrl`: AgentMemory REST origin, default `http://127.0.0.1:3111`;
- `apiSecret`: a Paperclip company secret reference containing
  `AGENTMEMORY_SECRET`.

Plain HTTP is accepted only for loopback. Use HTTPS when AgentMemory runs on a
different host or network namespace so the bearer secret and memory payloads
are encrypted in transit.

For separate local instances, allocate a distinct AgentMemory port and data
directory per company.

## Build and install from this checkout

```bash
pnpm --filter @paperclipai/plugin-agentmemory typecheck
pnpm --filter @paperclipai/plugin-agentmemory test
pnpm --filter @paperclipai/plugin-agentmemory build
paperclipai plugin install \
  /home/goose/TradingGoose/projects/paperclip/packages/plugins/agentmemory-plugin
```

The built entrypoints are `dist/manifest.js` and `dist/worker.js`. Paperclip
does not discover or build repository plugins automatically; the explicit
administrator install above is required.
