# Deployment, Reachability, and Authentication

Status: Canonical deployment contract

## Identity is invariant

Every human operator creates a real account and authenticates through Better
Auth. This is true on a developer laptop, a private network, and the public
internet. Listening on loopback does not create an implicit operator, and
changing network reachability never creates, transfers, or replaces an
account or session.

Better Auth owns signup, sign-in, profile updates, and sign-out:

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/update-user`
- `POST /api/auth/sign-out`

Paperclip authorization starts only after that session resolves to a persisted
Better Auth user. Instance roles, company memberships, preferences, secrets,
task attribution, and board API keys remain explicit records attached to that
user.

## Reachability

`server.bind` selects where the server listens:

| Bind | Meaning | Typical use |
| --- | --- | --- |
| `loopback` | Listen on localhost only | Local development or a reverse proxy |
| `lan` | Listen on all interfaces | A trusted LAN or VPN |
| `tailnet` | Listen on a detected Tailscale address | Tailnet-only access |
| `custom` | Listen on one explicit address | Advanced network layouts |

`server.exposure = private | public` selects transport hardening independently
of bind. It never changes human identity or session behavior.

- `private` derives the authentication origin from each incoming request and
  the configured bind/hostname policy.
- `public` requires the one canonical HTTPS `PAPERCLIP_PUBLIC_URL` (or the same
  persisted `auth.publicBaseUrl`) and the public-facing hostname,
  secure-cookie, rate-limit, proxy, secret, and runtime checks.

The public value must be an exact HTTPS origin with no credentials, path,
query, or fragment; HTTP is a startup/configuration error. Private exposure may
still use request-derived HTTP origins on controlled networks. Better Auth,
Next.js, and other framework URL aliases are not accepted.

## First administrator

A fresh database contains no human or administrator. First:

1. Open Paperclip and sign up or sign in through Better Auth.
2. On private exposure, use the first-admin setup action in the browser.
3. Alternatively, create a short-lived capability with:

   ```sh
   pnpm paperclipai auth bootstrap-admin
   ```

4. Redeem that capability while signed in.

The CLI command creates only a hashed invitation with
`source = bootstrap_admin_cli` and no inviter user. It cannot create an
account or grant authority before a real signed-in user redeems it. Public
exposure uses this high-entropy invitation flow instead of browser claim.

## Onboarding and diagnostics

```sh
pnpm paperclipai onboard
pnpm paperclipai configure --section server
pnpm paperclipai doctor
```

Onboarding asks about bind and exposure, requires an external PostgreSQL URL,
and persists one durable Better Auth secret. Doctor validates those inputs but
never creates a human account.

Examples:

```sh
pnpm paperclipai onboard --yes --bind loopback
pnpm paperclipai run --bind lan
pnpm paperclipai run --bind tailnet
```

Changing bind or exposure later preserves the same Better Auth users, sessions,
and authorization records.
