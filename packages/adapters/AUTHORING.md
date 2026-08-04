# ACPX Discovery Notes

Paperclip no longer accepts adapter packages as an agent catalog. Do not add a
package here to introduce an agent, model list, provider setting, executable,
or ACPX frontend.

The locally installed ACPX runtime is the sole catalog supplier. Paperclip
reads ACPX's exact registry names, probes each candidate through a disposable
ACPX runtime session, and creates an ephemeral `acpx-runtime/v1` definition
only for successful candidates. ACPX owns launch, models, selectable session
configuration, and provider execution; Paperclip owns durable authority and
request-scoped MCP.

To make a CLI available, install and authenticate its ACPX-compatible native
flow locally. See [Adding an ACPX-compatible CLI](../../docs/adapters/creating-an-adapter.md).

Every advertised non-secret ACPX option is persisted as an immutable session
configuration selection and applied through `session/set_config_option` before
the prompt. This includes a reasoning option when ACPX
advertises one; Paperclip never invents provider-specific options or values.
