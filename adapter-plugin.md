# ACPX Agent Discovery Contract

Paperclip has no adapter plugin API for adding agents, models, providers, or
configuration. Its local ACPX runtime is the sole supplier of the available
agent catalog.

The worker reads exact ACPX registry names, opens a discarded ACPX runtime
session to verify each candidate, and surfaces only compatible local CLIs. ACPX
owns the agent name, launch argv, advertised model values, selectable session
configuration, and provider runtime. Paperclip's `acpx-runtime`
bridge calls only ACPX's public runtime: it establishes the immutable new or
eligible-resume session, applies configuration, supplies the current
request-scoped MCP input, sends one prompt, projects updates, and requests
cancellation on abort. Paperclip owns durable authority, projection,
accounting, and request cleanup; it never resolves argv or speaks raw ACP to a
provider CLI.

An ACPX-advertised option such as `reasoning_effort` is persisted in the
immutable adapter revision JSON and applied through ACPX's
`session/set_config_option` control before each prompt. If ACPX does not
advertise an option, Paperclip does not
offer or synthesize it.

See `apps/docs/adapters/creating-an-adapter.md` and
`apps/docs/adapters/external-adapters.md`.
