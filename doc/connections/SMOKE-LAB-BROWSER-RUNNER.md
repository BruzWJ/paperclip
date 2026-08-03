# Smoke Lab browser fixture runbook

The maintained Smoke Lab browser check is
[`tests/e2e/smoke-lab.spec.ts`](../../tests/e2e/smoke-lab.spec.ts). Its scenario
catalog remains
[`tests/e2e/smoke-lab.catalog.ts`](../../tests/e2e/smoke-lab.catalog.ts); do not
fork that P1-P7 list.

The former live-instance browser runner has been retired. Automated browser
tests must not start Paperclip, authenticate to a deployed instance, accept a
database URL, or connect to PostgreSQL. The browser suite instead uses:

- the UI Vite server configured in
  [`tests/e2e/playwright.config.ts`](../../tests/e2e/playwright.config.ts);
- the test-owned API and domain state in
  [`tests/e2e/fixtures.ts`](../../tests/e2e/fixtures.ts);
- deterministic local MCP fixture processes where a scenario needs protocol
  traffic; and
- Playwright artifacts under `test-results/` for screenshots, traces, and
  failure evidence.

## Run the fixture-backed browser scenario

```bash
pnpm exec playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/smoke-lab.spec.ts
```

The Playwright configuration starts only Vite. API requests made by the page or
by the spec's `request` fixture are intercepted by `MockPaperclipApi`; the
fixture owns the companies, agents, connections, policies, approvals, audit
events, named gateways, smoke runs, and smoke-run steps needed by the scenario.

No operator account, Better Auth cookie, Paperclip server, PostgreSQL service,
or database environment variable is part of this test contract. A developer's
inherited database and libpq variables are also removed by the stable test
runner before automated tests execute.

## What the scenario proves

For each catalog path, the spec exercises the fixture-owned equivalent of:

1. connecting and selecting the correct deterministic transport;
2. discovering the canonical tool catalog;
3. allowing a read and recording audit evidence;
4. requiring and approving a write;
5. blocking a denied action;
6. quarantining an HTTP schema change;
7. disabling a connection or revoking a named-gateway token; and
8. recording the final audit evidence and screenshot artifact.

This is a UI and contract test, not a deployment smoke test. Production and
development still require an external PostgreSQL database, but that runtime
requirement is intentionally outside all automated test processes.

## Failure triage

Use the Playwright HTML report and artifacts from `test-results/`. A failure
should be reproducible against the deterministic fixture state; it must not be
"fixed" by pointing the suite at a development or production Paperclip
instance.
