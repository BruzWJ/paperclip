---
title: Adapters Overview
summary: Canonical ACP subprocess backends
---

ACP subprocess backends are Paperclip's only AI execution path. Paperclip is a
stable wire-v1 ACP client through the official TypeScript SDK; the selected
coding CLI, or its upstream-supported ACP frontend, is the ACP agent.

The initial and only conformance-approved backend is exact `codex`, launched
through ACPX's registry with immutable argv for pinned
`@agentclientprotocol/codex-acp@1.1.7`. ACPX contributes registry lookup only.
It does not own Paperclip sessions, queue work, translate Paperclip context, or
process events.

## One common execution path

For each prompt segment, Paperclip's worker:

1. resolves an immutable adapter revision and execution target;
2. launches a fresh supervised ACP subprocess;
3. initializes ACP and creates or resumes the eligible native session;
4. applies every required stable session configuration option;
5. attaches the complete request-scoped Paperclip MCP server set;
6. sends one exact text block and projects structured ACP updates; and
7. settles accounting, revokes request capability, and reaps the process.

The CLI owns provider authentication, native prompts/post-processing, its
model/tool loop, native tools, history, and compaction. Paperclip stores no AI
provider credential and does not call a provider API directly.

Generic process, HTTP, provider SDK, gateway, cloud-client, raw HTTPS, terminal
scraping, and provider-specific parser adapters are not supported. A backend
without conforming structured updates, stable resume/cancel, configuration,
context occupancy, and complete session-scoped MCP replacement is absent.

## Declarative definitions

Every built-in or external adapter is one closed `acp-subprocess/v1`
definition. It contains an approved immutable launch profile, target
requirements, readiness facts, UI metadata, required non-secret ACP config
options, and model/profile limits. It has no executable callback, parser,
prompt builder, session codec, authentication hook, or adapter-owned tool.

External packages can package this data independently but cannot widen the
approved launch catalog. See [Creating an Adapter](/adapters/creating-an-adapter)
and [External Adapters](/adapters/external-adapters).
