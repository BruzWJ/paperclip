# ACPX Agent Discovery Contract

Paperclip has no adapter plugin API for adding agents, models, providers, or
configuration. Its local ACPX runtime is the sole supplier of the available
agent catalog.

The worker reads exact ACPX registry names, opens a discarded ACPX runtime
session to verify each candidate, and surfaces only compatible local CLIs. ACPX
owns the agent name, launch argv, advertised model values, selectable session
configuration, and provider runtime. Paperclip's retained `acp-subprocess`
bridge calls only ACPX's public runtime for initialize/new-or-resume,
configuration, request-scoped MCP, prompt/update/stop, and cancellation;
Paperclip owns durable authority, projection, accounting, and request cleanup.

An ACPX-advertised option such as `reasoning_effort` is persisted in the
immutable adapter revision JSON and applied through ACPX's
`session/set_config_option` control before each prompt. If ACPX does not
advertise an option, Paperclip does not
offer or synthesize it.

See `docs/adapters/creating-an-adapter.md` and
`docs/adapters/external-adapters.md`.
