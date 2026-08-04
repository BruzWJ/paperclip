---
title: Adding an ACPX-compatible CLI
summary: Declare and discover a local ACP agent through ACPX
---

Paperclip does not accept hand-authored, built-in, or external adapter
definitions as an agent catalog. ACPX is the contract supplier for every agent
that Paperclip can show or run.

## Discovery comes first

When Paperclip refreshes the local catalog, it:

1. asks `acpx config show --format json` for ACPX's resolved `agents` map;
2. reads only the exact names explicitly present in that map;
3. rejects names that are empty or changed in any way;
4. asks ACPX to create a temporary, discarded ACPX runtime session for each
   listed name; and
5. surfaces only candidates whose ACP initialization and session probe succeed.

Install and authenticate the compatible CLI, then add its entry to
ACPX's global `~/.acpx/config.json` or project `.acpxrc.json` `agents` map. Use
`acpx config show --format json` to confirm the resolved entry. Paperclip does
not treat ACPX's built-in shortcuts as installed-agent evidence because some of
those shortcuts can download packages on demand.

A failed candidate is not selectable. Paperclip never adds an alias,
executable, command-line argument, model, or provider fallback; it checks exact
configured membership before asking ACPX to resolve the launch, so ACPX's
raw-command fallback is never a Paperclip launch surface.

## What ACPX supplies

The successful probe supplies the exact registry name, available model
identifiers, and stable generic session configuration options. Paperclip turns
that data into a closed `acpx-runtime/v1` revision contract. ACPX resolves and
launches the underlying local CLI through its public runtime; Paperclip does
not receive an argv or supervise a provider subprocess.

Paperclip does not infer portable model context limits: ACP does not define
them. A model is shown only when ACPX advertises it, and unknown limits remain
unknown rather than being guessed.

## Configuration, including reasoning effort

The agent settings form is generated entirely from the generic ACPX options
advertised for that local agent. For example, an ACPX agent may expose model,
mode, or reasoning-effort choices; another agent may expose a different set.
There is no Paperclip-specific list of option ids or values.

The selected values are stored as sorted immutable ACPX session configuration
selections in the adapter revision JSON. At run time, ACPX validates and
applies every saved selection before it sends the prompt. Thus a reasoning
setting is effective at runtime when, and only when, the selected ACPX agent
advertises it as a stable option.

## Boundaries that remain Paperclip-owned

Paperclip owns durable authority fences, request-scoped MCP, structured update
projection, cancellation requests, accounting, and its request-file cleanup.
ACPX owns provider launch, initialize/new/resume, temporary runtime state, and
cleanup. The local CLI owns provider authentication, native prompts and tools,
its model loop, native history, and compaction.

There is no adapter package, executable callback, parser, provider SDK client,
prompt builder, session codec, authentication hook, or provider-specific MCP
bridge to author in Paperclip. Install and authenticate the compatible CLI
through its own native flow, declare it in ACPX's `agents` configuration, then
let ACPX discovery surface it.
