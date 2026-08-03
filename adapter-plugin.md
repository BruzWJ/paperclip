# Adapter Backend Contract

Paperclip adapters are immutable `acp-subprocess/v1` backend definitions, not
provider execution plugins. A built-in or external module returns exactly a
stable adapter `type` and a closed declarative `definition`.

The definition may describe:

- one byte-exact ACPX registry name already present in Paperclip's immutable
  conformance-approved launch catalog;
- the catalog-owned pinned executable, argv, ACP frontend package, version,
  and digest;
- supported execution-target drivers and workspace requirements;
- stable ACP readiness facts;
- required non-secret `session/set_config_option` values; and
- schema-driven labels, configuration fields, models, and token limits.

ACPX is used only through `createAgentRegistry` / `AcpAgentRegistry` to resolve
an already-approved name. It does not own Paperclip prompts, sessions, queues,
events, tools, or process state. Paperclip's worker uses the official ACP
TypeScript SDK over supervised subprocess stdio for initialize, new/resume,
configuration, request-scoped MCP replacement, prompt/update/stop,
cancellation, projection, and cleanup.

An adapter definition cannot contain an execution callback, process or HTTP
transport, provider SDK/client, prompt renderer, stdout/parser codec, session
store, auth hook, provider-home mutation, tool implementation, arbitrary
command, or fallback. The selected CLI or pinned upstream ACP frontend owns
provider authentication and its native harness.

See `packages/adapters/AUTHORING.md`, `docs/adapters/creating-an-adapter.md`, and
`docs/adapters/external-adapters.md` for the executable contract and release
checks.
