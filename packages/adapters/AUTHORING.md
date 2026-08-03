# Adapter Authoring Notes

Paperclip AI adapters are declarative ACP subprocess definitions. The public
guide is [Creating an Adapter](../../docs/adapters/creating-an-adapter.md).

## Closed execution boundary

`ServerAdapterModule` has exactly two properties: `type` and `definition`.
`definition.version` is exactly `acp-subprocess/v1`. An adapter package may
describe an approved launch and its configuration, but it never executes a
provider request.

The definition may contain only:

- the exact approved ACPX registry name and immutable executable/argv;
- the exact ACP frontend package and version;
- execution-target cwd, directory, environment, and driver requirements;
- stable ACP readiness facts;
- schema-driven UI metadata;
- required non-secret stable ACP configuration options;
- model/profile values and immutable token limits.

Do not add execution callbacks, provider SDK or HTTP clients, prompt builders,
terminal/stdout parsers, session codecs or CLI resume flags, model CLI flags,
authentication probes, credential copyback, provider-home mutation, tool
injection, or adapter-local process/session state. The common official-SDK ACP
client owns initialize, new/resume, configuration, prompt, updates,
cancellation, and process cleanup.

## Registry admission

An adapter's `launchProfile.registryName` must be present byte-for-byte in both
ACPX's public registry and Paperclip's immutable conformance-approved catalog.
The source command, argv, frontend package, frontend version, and lowercase
SHA-256 frontend digest must exactly match that catalog entry. Never normalize
a name, accept an alias, invoke `npx`, use a semver range, or supply an
arbitrary command fallback.

The initial approved registry contains only exact `codex`, backed by pinned
`@agentclientprotocol/codex-acp@1.1.7`. A new frontend requires its own real
wire conformance suite and approved launch-catalog entry before an adapter may
reference it. An external package cannot widen the approved registry.

The catalog command and argv identify the worker-bundled source artifact; they
are not copied into a remote launch. For every selected execution target,
Paperclip resolves one absolute target Node path, materializes the verified
bundled frontend bytes into the request-scoped target directory, verifies those
bytes again on the target, and launches exactly that Node path with the
target-local frontend. Missing target Node, source drift, target drift, or an
unresolved path fails closed without install, global-frontend, or `npx`
fallback.

## Authentication and configuration

Provider authentication remains entirely native to the installed CLI.
Paperclip does not store, forward, probe, copy, or refresh any AI-provider
credential.

Every configuration field maps one-to-one to a required stable ACP
`session/set_config_option` selection. The schema and option keys are closed;
unknown or missing values fail. Exactly one option is the productive model,
and every advertised model supplies positive immutable context and output
limits. Configuration must not be encoded in argv, environment secrets,
prompt prose, or `_meta`.

## Workspace ownership

The adapter definition declares which existing execution-target drivers it
supports. It does not copy workspaces or run git. The common execution-target
path owns workspace realization, remote transfer, read-only selected-skill
materialization, and finalization. No adapter may introduce a git-remote,
secondary worker, tunnel, or alternate provider transport.

## Verification

Run the adapter-utils contract/type checks, server registry tests, and the
real-frontend ACP conformance suite. Tests must prove that unknown definition
fields fail, registry admission occurs before resolution, launch bytes are
immutable, configuration is nonempty and legal, and no callback or credential
surface exists.
