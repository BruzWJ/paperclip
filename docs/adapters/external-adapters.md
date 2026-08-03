---
title: External Adapters
summary: Package declarative ACP backend metadata independently
---

External adapters are immutable npm packages loaded by Paperclip at startup.
They use the same closed `acp-subprocess/v1` definition as built-ins and may
change declarative configuration or presentation without adding execution
code.

An external package does not make a new CLI trusted. Its exact ACPX registry
name must already exist in Paperclip's immutable conformance-approved launch
catalog, and its command, argv, frontend package, and frontend version must
match that entry byte-for-byte. The initial approved catalog contains only
exact `codex` with pinned `@agentclientprotocol/codex-acp@1.1.7`.

## Package

```text
my-paperclip-adapter/
  package.json
  dist/index.js
```

```json
{
  "name": "my-paperclip-adapter",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "dependencies": {
    "@paperclipai/adapter-utils": "<exact compatible version>"
  }
}
```

The root exports only `createServerAdapter()`. Its result has exactly `type`
and `definition`. Use the
[canonical source example](./examples/canonical-server-adapter.ts) as the
package entry point shape.

## Immutable loading

Paperclip validates the closed definition, computes the package artifact
digest, retains that exact artifact for immutable revision lookup, and
registers its implementation identity. Selection never falls back from an
invalid external definition to another type, normalized name, arbitrary
command, generic process transport, or HTTP transport.

The definition may reference only:

- an already approved launch profile;
- execution-target requirements;
- conformance readiness facts;
- schema-driven UI label and description;
- required non-secret stable ACP configuration options;
- model/profile values and immutable token limits; and
- static configuration guidance.

It cannot export or register an execution function, response parser, UI parser,
prompt builder, provider client, session codec, authentication hook, or tool
implementation. Paperclip's common official-SDK ACP client and projector own
all request, control, event, and terminal behavior.

## Authentication

Users install and authenticate the target coding CLI through its own native
flow on the selected execution target. Paperclip does not accept AI-provider
secrets in adapter configuration, probe login, copy credential homes, or
refresh provider tokens. Secret-shaped adapter configuration is invalid, not
redacted into a parallel path.

## Configuration and UI

The configuration form is generated from `definition.configSchema`. Every
field maps exactly once to a required stable ACP option in
`definition.configOptions`; unknown and missing fields fail. No downloadable
UI code or parser is loaded from the package. Structured ACP updates use the
single common transcript/event projector, while stdout and stderr remain
diagnostic process evidence only.

## Installation and release

Install from npm or a local directory through company adapter settings. A
release must pin an exact package version and pass:

- closed module-contract validation;
- exact approved-registry launch validation before `registry.resolve`;
- immutable artifact identity and reload tests;
- nonempty legal session-configuration and model-limit tests; and
- the common real-frontend ACP wire conformance suite.

If a frontend has not passed conformance and entered the approved catalog, the
package cannot be installed as a working adapter. There is no unsupported
tombstone or compatibility connector.

See [Creating an Adapter](/adapters/creating-an-adapter) for every definition
field.
