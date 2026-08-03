---
name: create-agent-adapter
description: Create or update a declarative Paperclip ACP subprocess adapter.
---

# Create a Paperclip Adapter

Use this skill only for the closed `acp-subprocess/v1` adapter contract.
Paperclip has no model-producing process, HTTP, SDK, gateway, or provider-CLI
adapter ABI.

## Verify admission before authoring

An adapter may reference an ACP backend only after the exact submitted name is
present byte-for-byte in both ACPX's `createAgentRegistry().list()` result and
Paperclip's immutable conformance-approved launch catalog. The catalog entry
must own an exact lockfile-installed executable/argv and exact frontend package
and version. Membership checks happen before `registry.resolve`.

Do not normalize names, accept aliases, run `npx`, use a semver range, download
on first use, or allow an arbitrary-command fallback. The initial approved
catalog contains only exact `codex`, using pinned
`@agentclientprotocol/codex-acp@1.1.7`. A new name requires a real-frontend ACP
wire conformance suite and catalog update before an adapter can use it.

## Canonical module

Return one `ServerAdapterModule` with exactly:

```ts
interface ServerAdapterModule {
  readonly type: string;
  readonly definition: AcpSubprocessAdapterDefinition;
}
```

The definition version is exactly `acp-subprocess/v1`. It may contain only:

- the approved immutable registry launch profile;
- execution-workspace cwd, authorized-directory, driver, and non-secret
  environment requirements;
- already-proven ACP readiness facts;
- static UI label/description metadata;
- a closed UI configuration schema;
- required stable ACP option ids and legal non-secret values;
- one required model option with immutable model token limits;
- optional declared model profiles; and
- static configuration guidance.

Use `resolveApprovedAcpLaunch` for the launch profile,
`validateServerAdapterModule` for the closed module, and
`resolveAcpAdapterRevisionConfiguration` for example configuration.

## Forbidden adapter behavior

Never add:

- `execute`, streaming, provider SDK, raw HTTP, or gateway callbacks;
- provider input lanes, provider-result fields, or provider event codecs;
- prompt/system builders or terminal/stdout parsers;
- native-session codecs, resume flags, adapter stores, or continuity keys;
- model/session CLI flags, `_meta` config, or config fallbacks;
- login/quota probes, credential fields, auth copyback, or home mutation;
- adapter-owned MCP/tool injection or Paperclip REST credentials;
- issue, run, Session, agent, company, workspace, or ACP-session selectors.

The common official-SDK ACP client owns initialize, new/resume, stable session
configuration, MCP replacement, prompt, updates, cancellation, and subprocess
cleanup. The common ACP projector owns all model output inspection. The target
CLI owns provider authentication, native prompt/post-processing, the native
model/tool loop, history, and compaction.

## Configuration rules

The `configSchema` field keys must exactly equal the `configKey` members in
`configOptions`. Every option is required and maps to one stable
`session/set_config_option` id with a closed nonempty set of legal string or
boolean values. Unknown, missing, duplicate, empty, or unstable values fail.

`modelConfigOptionId` names exactly one option. That option's string values
must exactly match `models[].value`; every model has positive immutable
`contextTokenLimit` and `outputTokenLimit`, plus an optional independent
`inputTokenLimit`. Never infer limits or accept a frontend default.

Provider authentication is CLI-native. Paperclip adapter configuration stores
no AI-provider secret or secret reference.

## Workspace and skills

The definition declares target requirements but performs no workspace or skill
filesystem operation. Existing common execution-target mechanics own workspace
realization, remote transfer, read-only selected-skill materialization, and
finalization. Do not introduce a separate worker, connected-machine path,
tunnel, git-remote workflow, or provider transport.

## Required checks

Run the package typecheck and focused contract tests. Cover:

- exact module and nested definition keys;
- exact registry membership before resolution and immutable launch bytes;
- rejection of whitespace, case, punctuation, aliases, and unknown names;
- nonempty legal sorted ACP configuration selections;
- exact model-option/value/limit matching;
- absence of executable/parser/session/auth/tool callback fields; and
- the shared real-frontend ACP conformance suite.
