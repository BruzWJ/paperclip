# @paperclipai/adapter-utils

Shared utilities for Paperclip's ACPX-discovered local agents. ACPX owns agent
discovery, launch resolution, sessions, and execution. Paperclip supplies the
authorized local workspace, request-scoped MCP files, cancellation, cleanup,
and an optional local Bubblewrap confinement boundary.

For the ACPX discovery contract, see
[`apps/docs/adapters/creating-an-adapter.md`](../../apps/docs/adapters/creating-an-adapter.md).

## Local execution boundary

The local execution-workspace cwd is the only persistence boundary across
runs. Provider commands must already resolve locally; adapter-utils never
installs or materializes a provider package as part of execution.
