---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | required unless configured in `database.connectionString` | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Transport hardening policy: `private` or `public`; authentication is always Better Auth |
| `PAPERCLIP_PUBLIC_URL` | required for public exposure; unset for private | The sole external HTTPS Paperclip origin (no credentials, path, query, or fragment) for public authentication, callbacks, and links. An HTTP value is a configuration error. Private deployments derive the auth origin from each request and may use HTTP on controlled networks. It is server control-plane configuration and is never delivered to a provider child. |

Do not set Better Auth, Next.js, or other framework URL aliases. Paperclip
accepts only `PAPERCLIP_PUBLIC_URL` for public exposure and fails startup when
an unsupported alias is present.

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | required | Durable Better Auth signing secret; generate it once and preserve it across restarts |
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Provider Runtime Boundary

Paperclip injects no caller identity, issue metadata, workspace metadata, general REST credential, or wake payload through provider-child environment variables. A local provider receives only its resolved execution directory as the process working directory, operator-authored provider-native environment/configuration, and the run-scoped compiled-tools transport supplied by the adapter runtime.

Provider-native authentication and configuration stay operator-owned and target-scoped. Paperclip does not infer, seed, copy, or reconcile a provider home or credential store.

Provider credential, model, and home variables set on the Paperclip server
process are not inherited by provider children. Bind any required value
explicitly in that agent's adapter configuration, or prepare provider-native
configuration directly on the declared execution target.
