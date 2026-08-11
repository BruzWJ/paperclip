# AgentMemory plugin

First-party Paperclip adapter for a separately hosted
[`@agentmemory/agentmemory`](https://www.npmjs.com/package/@agentmemory/agentmemory)
service. The plugin automatically records canonical Paperclip work and exposes
four read-only recall tools through Paperclip's run-scoped prompt interface.
Paperclip core has no AgentMemory or memory-specific API.

## Memory matrix

| Paperclip memory cell | Read tool | AgentMemory namespace |
| --- | --- | --- |
| Task + current agent | `read_task_agent_memory(taskId, query)` | task scope + company-scoped agent principal |
| Task shared | `read_task_shared_memory(taskId, query)` | task scope + company-scoped shared principal |
| Company + current agent | `read_company_agent_memory(query)` | company scope + company-scoped agent principal |
| Company shared | `read_company_shared_memory(query)` | company scope + company-scoped shared principal |

The provider-visible MCP names are prefixed with
`paperclip.agentmemory__`. Sub-tasks and other company tasks use the same two
task tools after the agent obtains a task ID through Paperclip's ordinary
task tools.

There is no separate memory-access configuration. Paperclip derives authority
from the agent's existing context-access matrix on every tool call:

- task-agent memory requires the matching current, descendant, or company
  agent-run detail grant;
- task-shared memory requires the matching comment detail grant;
- company-agent memory requires company task listing plus company agent-run
  detail;
- company-shared memory requires company task listing plus company comment
  detail.

Knowing a task ID is not authority. The host must also resolve that task as
visible within the current agent run.

## AgentMemory coordinate translation

AgentMemory's REST API accepts `project` and `agentId`; those names are transport
fields, not Paperclip Project ownership. The adapter translates the matrix
directly:

| Paperclip coordinates | AgentMemory `project` | AgentMemory `agentId` |
| --- | --- | --- |
| `companyId + agentId` | opaque company scope | opaque company-scoped agent |
| `companyId` | opaque company scope | opaque company-scoped shared principal |
| `companyId + taskId + agentId` | opaque task scope | opaque company-scoped agent |
| `companyId + taskId` | opaque task scope | opaque company-scoped shared principal |

Raw Paperclip IDs never leave the plugin. Every coordinate is hashed, and every
observation session ID carries an opaque scope prefix. Memory-tool searches use
both the exact AgentMemory project and exact agent principal; the plugin also
rejects results whose session ID is not owned by that scope. This second check
is required because AgentMemory 0.9.28 can let an orphaned search-index entry
pass its project filter when its original session row is missing.

## Automatic updates

Immediately before each provider request, the blocking plugin hook:

1. reads the canonical Session through the exact source-message snapshot;
2. records newly visible current-agent prompts, finalized assistant text, and
   bounded completed/failed non-memory tool results into task-agent and
   company-agent memory;
3. records canonical task comments through the same projection boundary into
   task-shared and company-shared memory.

The hook is capture-only: it never searches or injects memory into a provider
request. Agents retrieve memory only by calling the four read-only
Paperclip-managed memory tools. A capture failure stops provider transmission,
so an agent never advances past a memory update that the plugin could not
confirm.

Terminal run events eagerly warm task-agent and company-agent memory so a
later memory-tool call can recall the completed run even from another provider
session.
Shared comments need no second event path: the next blocking prompt catches
them up before provider transmission.

Reasoning, provider metadata, Paperclip-redacted secrets, and AgentMemory recall
tool calls/results are excluded from capture.

## Receipt and retry contract

Each canonical source item has a deterministic, opaque one-observation
AgentMemory session ID that includes its canonical source identity. Equal text
or timestamps from different messages, comments, runs, or turns therefore do
not collapse.

AgentMemory writes a raw observation before compression/indexing. The plugin
does not treat that raw row as success: it polls the exact session until the row
has the compressed shape, expected timestamp, expected observation ID when one
was returned, and exact AgentMemory transport `agentId`. Only then may Paperclip
advance its checkpoint. A checkpoint also stores the latest receipt for both
partitions and revalidates those receipts before reuse, so resetting an
AgentMemory database behind the same URL causes a canonical backfill.

The adapter never calls `/agentmemory/context`: AgentMemory 0.9.28 can include
global pinned slots and projectless lessons there. It also never calls
`/agentmemory/session/end` for deterministic observation sessions, because
retries of that endpoint retrigger summarization, reflection, graph extraction,
and consolidation. Safe recall uses `/agentmemory/search` with exact project,
agent, and Paperclip session ownership checks.

## Configure

Start AgentMemory separately. Version `0.9.28` is the verified API contract.

```bash
AGENTMEMORY_SECRET='<strong-random-secret>' \
  npx -y @agentmemory/agentmemory@0.9.28 \
  --data-dir /absolute/path/to/paperclip-agentmemory-data
```

Open **Instance Settings → Plugins → AgentMemory** and configure the one
instance-wide installation:

- `baseUrl`: AgentMemory REST origin, default `http://127.0.0.1:3111`;
- `apiSecret`: the same bearer secret as `AGENTMEMORY_SECRET`, stored in the
  plugin installation config.

All companies use this connection. No company secret or per-agent setting is
required. Plain HTTP is accepted only for loopback; use HTTPS for any remote or
container-network endpoint.

## Build and install from this checkout

```bash
pnpm --filter @paperclipai/plugin-agentmemory typecheck
pnpm --filter @paperclipai/plugin-agentmemory test
pnpm --filter @paperclipai/plugin-agentmemory build
pnpm paperclipai plugin install --local ./packages/plugins/agentmemory-plugin
```

A workspace package is source code, not an installed plugin. On a Paperclip
source checkout, an instance admin can build and install AgentMemory directly
from the Plugin Manager's available-plugin list; the CLI commands above remain
the explicit development and verification path. Runtime memory traffic always
uses the AgentMemory REST API.
