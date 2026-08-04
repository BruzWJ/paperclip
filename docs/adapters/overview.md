---
title: Adapters Overview
summary: Canonical ACPX runtime backends
---

The ACPX public runtime is Paperclip's only AI execution path. ACPX runs the
selected compatible local CLI (including CLIs that are not ACP-native) and
exposes its generic runtime/session contract to Paperclip.

ACPX is Paperclip's sole agent catalog supplier. At runtime Paperclip asks the
locally installed ACPX registry for exact names, opens a temporary discarded
ACPX session for each candidate, and surfaces only candidates that initialize
successfully. The agent name, models, configuration fields, choices, and
defaults are ACPX data; Paperclip does not maintain a parallel agent, model,
frontend, or provider catalog.

ACPX does not own Paperclip's issue sessions, queue work, translated context,
request-scoped tools, or event projection. Paperclip owns those durable
control-plane concerns; ACPX owns local provider launch, session lifecycle,
and its temporary runtime state.

## One common execution path

For each prompt segment, Paperclip's worker:

1. resolves an immutable adapter revision and execution target;
2. creates an ephemeral, single-prompt ACPX runtime in that workspace;
3. asks ACPX to create a provider backend session or perform the exact frozen
   resume operation;
4. applies every persisted generic session configuration option through ACPX;
5. attaches the complete request-scoped Paperclip MCP server set;
6. sends one exact text block and projects structured ACP updates; and
7. settles accounting, revokes request capability, closes the ACPX runtime,
   and deletes its temporary state store.

The CLI owns provider authentication, native prompts/post-processing, its
model/tool loop, native tools, history, and compaction. Paperclip stores no AI
provider credential and does not call a provider API directly.

Paperclip does not implement a generic provider process, HTTP, SDK, gateway,
raw HTTPS, terminal scraper, or provider-specific parser path. A candidate is
selectable only after its ACPX session/configuration probe succeeds. Each
actual prompt receives a fresh request-scoped MCP server set through ACPX; an
ACPX setup or control operation that the frontend cannot complete fails closed.
The current ACPX public runtime admits only local targets and `operator_native`
skills.

## Declarative definitions

For a compatible result, Paperclip creates one data-only
`acpx-runtime/v1` definition from the ACPX probe. It contains the exact
registry name, target requirements, observed ACPX runtime controls, UI metadata, and every
selectable non-secret ACPX session option. It has no executable callback,
parser, prompt builder, session codec, authentication hook, or adapter-owned
tool.

The form is generic: if ACPX advertises a reasoning option (or any other
selectable or freeform string option), Paperclip surfaces it and persists the
selected value with the immutable adapter revision. Before every prompt, the
ACPX runtime applies every persisted selection. If an option is not advertised,
Paperclip does not invent it.

See [Adding an ACPX-compatible CLI](/adapters/creating-an-adapter) for the
discovery contract.
