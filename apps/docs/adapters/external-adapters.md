---
title: External Adapters
summary: ACPX owns the selectable agent catalog
---

External Paperclip adapter packages are not a way to add an agent, model, or
provider configuration. Paperclip intentionally has no extension point that
can register an adapter definition, executable, launch argv, frontend, or
model list.

Install an ACPX-compatible CLI locally and authenticate it with its native
flow. Paperclip's ACPX discovery pass reads ACPX's registry, refuses to
materialize absent CLIs during discovery, and surfaces a local candidate only
if it successfully initializes an ACPX runtime session. ACPX supplies the exact
name, launch, model options, generic session configuration, and execution
runtime; Paperclip supplies durable authority and request-scoped MCP. An ACPX
`agents` entry is needed only for a custom name or launch override.

This prevents a package from widening the runtime with a raw command, HTTP
provider client, parser, prompt builder, session codec, authentication hook, or
tool implementation. The board receives only the configuration that ACPX
actually advertises for the locally compatible agent.

If ACPX later reports a selectable `reasoning_effort` option, it appears like
any other session configuration choice. The immutable revision stores the
selection and ACPX applies it through its public
`session/set_config_option` control before the prompt. Paperclip neither synthesizes a
reasoning option nor maps provider-specific flags.
