# MCP Fixture Smoke Harness

Paperclip's MCP permission work uses deterministic fixture servers so policy
logic can be tested without real customer credentials or live integrations.

Run the local smoke:

```sh
pnpm smoke:mcp-fixtures
```

The runner starts one local stdio fixture and one remote-style HTTP fixture. It
does not contact a Paperclip instance or database. It then exercises:

- allow and deny decisions
- approval-gated writes
- audit records
- fixture runtime startup, health, slow response, crash response, and teardown
- missing-secret and fake OAuth failure paths
- schema-change quarantine
- malicious metadata/result handling
- approved-write idempotency

JSON output for local tooling or an isolated CI fixture job:

```sh
pnpm smoke:mcp-fixtures -- --json
```

## Fixture Catalog

The catalog lives in `scripts/mcp-fixtures/catalog.mjs` and includes:

- echo/calculator/time read tools
- synthetic todo and KV tools
- outbox email tools
- mock social/blog publishing tools
- malicious metadata and malicious result tools
- slow and crashing stdio tools
- fake OAuth and missing-secret tools

The catalog also defines the first profile set:

- `read-only`
- `approval-gated-writes`
- `security-hostile`
- `runtime-lifecycle`

The first-install demo definitions are:

- `direct-read-tools`
- `child-issue-proposal`
- `github-triage`
- `update-sender`
- `content-publishing`
- `local-project-helper`
- `ops-status`
- `crm-sales-note-draft`

The fixture harness validates provider behavior and policy enforcement in
process-owned state. Browser coverage uses the Vite-only Playwright fixture in
`tests/e2e/fixtures.ts`; named-gateway scenarios are defined by
`tests/e2e/smoke-lab.catalog.ts` and exercised by
`tests/e2e/smoke-lab.spec.ts`. Agent runs consume only the concrete company
tools selected into their compiled `paperclip.run-tools/v1` interface.
