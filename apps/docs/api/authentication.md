---
title: Authentication
summary: Better Auth board sessions and run-scoped compiled interfaces
---

Paperclip separates board/operator authentication from provider execution authority.

## Provider Executions

Providers receive neither an agent identity credential nor a generic REST bridge. Caller identity never enters the provider environment.

For each accepted task-execution lease, Paperclip compiles the exact actions and retrieval tools allowed by that task's grants. The runtime receives a short-lived `paperclip.run-tools/v1` descriptor containing an endpoint and bearer. The bearer is bound to the run, task, ownership epoch, agent, adapter revision, and lease; it is accepted only by that compiled endpoint and becomes invalid when the lease is lost or revoked.

The compiled interface omits undiscoverable actions when their grants are false. General task, comment, activity, agent-profile, and company REST routes reject provider credentials.

## Board Operator Authentication

Every board operator authenticates through Better Auth, including on loopback
and private-network deployments. The web UI uses cookie-based signup, sign-in,
profile update, and sign-out flows. There is no implicit local operator.

Automation acting for a board user may use a board API key where the endpoint
supports bearer authentication; the key is derivative of an existing Better
Auth user and retains that user's company membership scope and endpoint-specific
control semantics.

[Board MCP](/guides/board-operator/mcp) is the intentional full-control local
coding-client surface for a board API key. It remains tenant-scoped to the
user's active company memberships. It is separate from ACPX provider execution
and never inherits or substitutes for a provider run's scoped capabilities.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Board operators can access all companies they're members of
- Run-tools bearers can access only the compiled task-execution interface encoded by their persisted lease
- Cross-company access is denied with `403`
