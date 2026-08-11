---
title: Exposure and Bind
summary: Configure network reachability without changing authentication
---

Paperclip uses the same Better Auth signup, sign-in, profile, and sign-out
lifecycle on every network. Bind controls where the server listens; exposure
controls transport hardening. Neither setting selects a different human
identity path.

## Bind

| Value | Reachability |
| --- | --- |
| `loopback` | Localhost only |
| `lan` | All interfaces on a LAN or VPN |
| `tailnet` | A detected Tailscale address |
| `custom` | One explicitly configured address |

Configure it during onboarding or at runtime:

```sh
pnpm paperclipai onboard
pnpm paperclipai run --bind tailnet
```

## Exposure

`private` is appropriate for loopback and controlled private networks; its auth
origin is derived from each request and the configured bind/hostname policy.
`public` enables the stricter internet-facing checks and requires the sole
exact HTTPS origin in `PAPERCLIP_PUBLIC_URL` (or the same persisted
`auth.publicBaseUrl`). Both require a real Better Auth account and session.
An HTTP public URL is a configuration error, while private exposure may retain
request-derived HTTP origins on controlled networks. Better Auth, Next.js, and
other framework URL aliases are not accepted.

```sh
PAPERCLIP_DEPLOYMENT_EXPOSURE=private pnpm paperclipai run --bind lan
```

For a public deployment, use TLS through a trusted reverse proxy, set the
canonical public URL, configure trusted proxy/hostname policy, retain a durable
`BETTER_AUTH_SECRET`, and enable the required rate limiting.

## First administrator

On a fresh instance, sign up through Better Auth before claiming any Paperclip
authorization. Private exposure offers the signed-in browser first-admin
action. The operator may instead create a one-time capability:

```sh
pnpm paperclipai auth bootstrap-admin
```

Public exposure requires that invitation flow. It creates no account; the
signed-in Better Auth user receives authority only when redeeming it.
