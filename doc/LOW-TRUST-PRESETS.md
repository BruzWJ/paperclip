# Low-Trust Presets

Paperclip ships core trust preset names so containment decisions are enforced in
Community Edition even when EE policy editing is unavailable.

## Presets

- `standard`: the default V1 company-visible collaboration model. This preserves
  existing behavior for normal agents.
- `low_trust_review`: an opt-in containment preset for automated work that may
  consume hostile or prompt-injected input, such as untrusted pull requests,
  external tickets, dependency diffs, or generated review output.

## Boundary Model

`low_trust_review` has one task/run JSON policy shape:

- preset selector: `executionPolicy.reviewPreset`
- company-local scope: `executionPolicy.authorizationPolicy.trustBoundary`

Both fields are required together. Preset selectors named `trustPreset` or
placed inside `authorizationPolicy` are invalid. The resolver intersects task
and run policy sources; narrower wins. A low-trust preset must resolve to a
concrete company-local project, root task, or task-id scope. If a policy source
names another company, uses an unsupported preset, or lacks that scope for
risky access, Paperclip fails closed.

## Containment, Not Privacy

This is containment for hostile automated work. It is not a general project,
task, or human privacy system.

V1 standard work remains company-visible by default: board users and in-company
actors can inspect company work objects unless a separate access-control feature
changes that behavior. Low-trust containment instead limits the request-scoped
tools compiled for the low-trust execution and prevents raw untrusted output
from being automatically promoted into higher-trust agent context. Providers do
not receive a generic Paperclip REST credential.

Low-trust agents cannot read or mutate agent configuration or agent instructions
through direct grants. Configuration changes from
low-trust work must go through higher-trust review and promotion paths instead.

## Runtime Containment

Managed `low_trust_review` runs fail closed unless Paperclip can enforce the
runtime boundary:

- the runtime must enforce the selected sandbox boundary
- the task being run must be inside the resolved low-trust boundary
- secret references must use binding ids explicitly allowed by the boundary
- inline sensitive values such as API keys and tokens are rejected

The Docker workflow in `doc/UNTRUSTED-PR-REVIEW.md` remains useful for manual
local review, but Paperclip-managed low-trust execution requires a sandboxed
execution target instead of a host-local provider subprocess.
