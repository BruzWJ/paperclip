---
title: Deployment Overview
summary: Better Auth, network reachability, and exposure at a glance
---

Paperclip has one human account and session lifecycle in every environment:
signup and sign-in through Better Auth. Deployment choices affect reachability
and transport hardening, never identity.

## Quick comparison

| Environment | Bind | Exposure | Human account |
| --- | --- | --- | --- |
| Developer laptop | `loopback` | `private` | Better Auth signup/sign-in |
| Tailnet, VPN, or LAN | `tailnet` or `lan` | `private` | Better Auth signup/sign-in |
| Internet-facing service | Usually `loopback` behind a proxy | `public` | Better Auth signup/sign-in |

Local development keeps the server on localhost. Private networks derive auth
origin from each request and add hostname policy appropriate to the controlled
network. Public exposure requires the sole `PAPERCLIP_PUBLIC_URL` (or the same
persisted `auth.publicBaseUrl`) as an exact HTTPS origin, TLS/reverse-proxy configuration, strict
secrets, secure cookies, and rate limiting.

Choose bind and exposure during onboarding:

```sh
pnpm paperclipai onboard
```

Update them later without changing users or sessions:

```sh
pnpm paperclipai configure --section server
```

See [Exposure and Bind](exposure-and-bind.md), [Tailscale Private Access](tailscale-private-access.md),
or the [AWS ECS Fargate guide](aws-ecs.md).
