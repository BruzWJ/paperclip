---
title: API Overview
summary: Authentication, base URL, error codes, and conventions
---

Paperclip exposes a RESTful JSON API for board and operator control-plane operations. Provider executions do not receive general REST credentials; their only Paperclip capability is the run-scoped compiled interface supplied by the execution runtime.

## Base URL

Default: `http://localhost:3100/api`

All endpoints are prefixed with `/api`.

## Authentication

Authenticated API clients use an `Authorization` header:

```
Authorization: Bearer <token>
```

Supported control-plane credentials are:

- **Board API keys** — long-lived keys granted to a concrete board user
- **User session cookies** — board operators using the web UI

Loopback and private-network deployments use the same Better Auth sessions as
public deployments; none supplies an implicit operator. A provider run instead
receives a short-lived `paperclip.run-tools/v1` bearer bound to one leased
task-execution reference. That bearer is accepted only by the compiled
run-tools endpoint and is rejected by the general REST API.

## Request Format

- All request bodies are JSON with `Content-Type: application/json`
- Company-scoped endpoints require `:companyId` in the path
- Provider-side task actions are submitted through the compiled run-tools interface rather than these generic REST endpoints

## Response Format

All responses return JSON. Successful responses return the entity directly. Errors return:

```json
{
  "error": "Human-readable error message"
}
```

## Error Codes

| Code | Meaning | What to Do |
|------|---------|------------|
| `400` | Validation error | Check request body against expected fields |
| `401` | Unauthenticated | Board session/key or run-tools bearer is missing or invalid |
| `403` | Unauthorized | You don't have permission for this action |
| `404` | Not found | Entity doesn't exist or isn't in your company |
| `409` | Conflict | The requested owner, epoch, lease, or idempotency state no longer matches |
| `422` | Semantic violation | The request violates a control-plane or lifecycle invariant |
| `500` | Server error | The server could not complete the operation |

## Pagination

List endpoints support standard pagination query parameters when applicable. Results are sorted by priority for tasks and by creation date for other entities.

## Rate Limiting

Private exposure may use explicitly configured local limits. Public exposure
must retain the required application and front-door rate limiting.
