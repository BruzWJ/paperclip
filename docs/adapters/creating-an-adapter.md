---
title: Creating an Adapter
summary: Define a conformance-approved ACP subprocess backend
---

Paperclip adapters are immutable descriptions of approved ACP subprocesses.
They do not contain provider execution code. Paperclip's common ACP client uses
the official TypeScript SDK, speaks stable wire version 1, and owns process
supervision, session setup, configuration, prompt delivery, structured updates,
cancellation, and cleanup for every adapter.

## Admission comes first

A package cannot make an arbitrary CLI supported. Before adding a definition,
the exact registry name must:

1. appear byte-for-byte in ACPX's `createAgentRegistry().list()` result;
2. have an immutable Paperclip launch-catalog entry with a lockfile-installed
   executable/argv and exact frontend package/version; and
3. pass the real-frontend conformance suite for initialize, new, stable resume,
   stable session configuration, prompt/update/stop, cancellation, context
   occupancy, and complete session-scoped MCP replacement.

Paperclip checks both memberships before calling `registry.resolve`. Names are
never trimmed, case-folded, punctuation-folded, aliased, or defaulted. Unknown
names cannot reach ACPX's raw-command fallback. The initial catalog contains
only exact `codex`, backed by
`@agentclientprotocol/codex-acp@1.1.7`.

## Package shape

An external package needs only one JavaScript entry point:

```text
my-adapter/
  package.json
  src/index.ts
```

It exports `createServerAdapter()`. The returned value contains exactly
`type` and `definition`; unknown fields are registration errors.

```ts
import {
  type AdapterModel,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  resolveApprovedAcpLaunch,
} from "@paperclipai/adapter-utils/acp-subprocess";

const launchProfile = resolveApprovedAcpLaunch("codex");

const models = Object.freeze([
  Object.freeze({
    id: "gpt-5.6",
    label: "GPT-5.6",
    value: "gpt-5.6",
    limits: Object.freeze({
      contextTokenLimit: 1_050_000,
      inputTokenLimit: 922_000,
      outputTokenLimit: 128_000,
    }),
  }),
] satisfies readonly AdapterModel[]);

export function createServerAdapter(): ServerAdapterModule {
  return Object.freeze({
    type: "example_codex",
    definition: Object.freeze({
      version: "acp-subprocess/v1",
      launchProfile,
      environment: Object.freeze({
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: Object.freeze(["local", "ssh", "sandbox", "plugin"]),
        environmentKeys: Object.freeze([]),
      }),
      readiness: Object.freeze({
        protocolVersion: 1,
        resume: true,
        cancel: true,
        sessionConfig: true,
        sessionScopedMcpReplacement: true,
        cliNativeAuthentication: true,
      }),
      ui: Object.freeze({
        label: "Example Codex definition",
        description: "Codex through its approved ACP frontend.",
      }),
      configSchema: Object.freeze({
        fields: Object.freeze([{
          key: "model",
          label: "Model",
          type: "select",
          required: true,
          options: Object.freeze([
            Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
          ]),
        }]),
      }),
      configOptions: Object.freeze([{
        id: "model",
        configKey: "model",
        label: "Model",
        required: true,
        values: Object.freeze([
          Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
        ]),
      }]),
      modelConfigOptionId: "model",
      models,
      modelProfiles: Object.freeze([]),
      configurationDoc:
        "Install and authenticate Codex through its native CLI first.",
    }),
  });
}
```

The repository keeps this exact shape in the
[executable documented example](./examples/canonical-server-adapter.ts).

## Definition fields

`launchProfile` is copied from the approved catalog. A definition cannot
replace its registry name, source command, source argv, package, version, or
lowercase SHA-256 frontend digest. The source argv is an immutable artifact
identity, not a remote command: the common runtime verifies and materializes
those frontend bytes on the selected target, resolves one absolute target Node
path, and launches only the target Node plus target-local frontend. There is no
install, global-frontend, or `npx` fallback.

`environment` declares requirements only. The common execution-target path
resolves the absolute workspace and performs local, SSH, sandbox, or plugin
launch mechanics. The definition cannot launch another process or invent a
remote transport. `environmentKeys` contains non-secret frontend requirements
only and may not include `PAPERCLIP_*` values.

`readiness` records conformance facts already proven by the frontend suite. It
does not run a prompt, auth test, quota probe, or provider API call.

`configSchema` is the UI form. Its field keys must exactly equal the
`configKey` values in `configOptions`. Every option is required, has a stable
ACP option id, and contains a closed set of legal string or boolean values.
Paperclip sorts selections and sends each through stable
`session/set_config_option` after every successful new or resume.

`modelConfigOptionId` identifies exactly one required option. Its string
values must match `models[].value` exactly. Each model contains immutable
positive context/output limits and an optional independent input limit.
Model profiles may point only at entries in that same catalog.

## Deliberately absent

An adapter has no:

- execution, stream, provider-SDK, or HTTP callback;
- prompt renderer, terminal parser, event mapper, or UI parser;
- native-session codec, resume flag, or adapter session store;
- model/config CLI flag or `_meta` fallback;
- provider credential field, secret reference, login probe, or auth copyback;
- provider-home mutation, tool injection, or provider-specific MCP bridge;
- Paperclip identity, issue/run/session selector, or generic API credential.

The target CLI owns its native prompts, model/tool loop, native history,
native compaction, and authentication. The common ACP projector is the only
response-inspection path.

## Verification

Validate the module with `validateServerAdapterModule`, resolve example user
configuration with `resolveAcpAdapterRevisionConfiguration`, and run the
registry-admission and real-frontend conformance suites. An adapter is not
shipped until the exact frontend passes the common wire tests; there is no
process, HTTP, SDK, parser, or command fallback.

See [External Adapters](/adapters/external-adapters) for packaging details.
