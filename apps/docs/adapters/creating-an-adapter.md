---
title: Adding an ACPX-compatible CLI
summary: Install and discover a local ACP agent through ACPX
---

Paperclip does not accept hand-authored, built-in, or external adapter
definitions as an agent catalog. ACPX is the contract supplier for every agent
that Paperclip can show or run.

## Discovery comes first

When Paperclip refreshes the local catalog, it:

1. loads the exact names and launch resolution from ACPX's public registry;
2. merges ACPX's global/project `agents` launch overrides without treating
   that map as an enablement list;
3. rejects names that are empty or changed in any way;
4. applies a generic, non-launching local-install check so discovery cannot
   download an absent CLI through a package runner;
5. asks ACPX to create a temporary, discarded runtime session for each local
   candidate; and
6. surfaces only candidates whose ACP initialization and session probe succeed.

Install and authenticate the compatible CLI on the Paperclip host. Normally no
ACPX configuration is needed for a built-in registry entry. Add an entry to
ACPX's global `~/.acpx/config.json` or project `.acpxrc.json` `agents` map only
when you need a custom name or launch override. Paperclip does not treat a
built-in shortcut by itself as installed-agent evidence because some shortcuts
can download packages on demand.

A failed candidate is not selectable. Paperclip never adds a provider alias,
executable mapping, command-line argument, model, or fallback. It checks exact
ACPX registry membership before launch, so ACPX's raw-command fallback is never
a Paperclip surface.

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
through its own native flow, then let ACPX discovery surface it. Use an ACPX
`agents` entry only for a custom launch override.
