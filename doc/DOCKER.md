# Docker Quickstart

Run Paperclip in Docker without installing Node or pnpm locally.

All commands below assume you are in the **project root** (the directory containing `package.json`), not inside `docker/`.

## Building the image

```sh
docker build -t paperclip-local .
```

The Dockerfile installs common runtime tools (`git`, `gh`, `curl`, `wget`,
`ripgrep`, `python3`). It does not install provider CLIs or provider-specific
adapter packages.

Build arguments:

| Arg | Default | Purpose |
|-----|---------|---------|
| `USER_UID` | `1000` | UID for the container `node` user (match your host UID to avoid permission issues on bind mounts) |
| `USER_GID` | `1000` | GID for the container `node` group |

```sh
docker build -t paperclip-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

## One-liner (build + run)

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e DATABASE_URL=postgres://paperclip:paperclip@host.docker.internal:5432/paperclip \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Open: `http://localhost:3100`

Data persistence:

- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-paperclip` in the example above).

## Docker Compose

### Quickstart

Application and PostgreSQL containers run together. Application data persists
via a bind mount and database data persists in the compose volume.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-paperclip`

Optional overrides:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

Private deployments derive the authentication origin from each browser request. Set `PAPERCLIP_PUBLIC_URL` only when changing the deployment exposure to `public`.

Do not pass provider credentials as Paperclip server environment variables.
Prepare provider-native configuration on the declared execution target, or
bind a credential explicitly in an individual adapter configuration.

### Full stack (with PostgreSQL)

Paperclip server + PostgreSQL 17. The database is health-checked before the server starts.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.yml up --build
```

PostgreSQL data persists in a named Docker volume (`pgdata`). Paperclip data persists in `paperclip-data`.

### Untrusted PR review

Isolated container for reviewing untrusted pull requests with Codex or Claude, without exposing your host machine. See `doc/UNTRUSTED-PR-REVIEW.md` for the full workflow.

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## Compose with a single public URL

Every deployment uses Better Auth. Set one canonical HTTPS public origin and let
Paperclip derive auth/callback defaults:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_EXPOSURE: public
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

For public exposure, `PAPERCLIP_PUBLIC_URL` must be an exact HTTPS origin with
no credentials, path, query, or fragment. HTTP is rejected. It is the sole source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

For private exposure, leave `PAPERCLIP_PUBLIC_URL` unset so Better Auth derives
the origin from each request. For fresh private Docker or appliance-style installs, the first admin can be
claimed entirely from the browser after sign-in. Open the
Paperclip URL, sign in or create an account, then choose `Claim this instance`
on the setup screen. This browser claim is disabled for public exposure;
public deployments must run the high-entropy CLI invite path instead:

```sh
pnpm paperclipai auth bootstrap-admin
```

Use `PAPERCLIP_PUBLIC_URL` as the one external HTTPS origin. Set `PAPERCLIP_ALLOWED_HOSTNAMES` only for additional accepted hostnames; Better Auth, Next.js, and other framework URL aliases are not supported.

Set `PAPERCLIP_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

## Adapter Transports in Docker

The Paperclip image contains the built-in `process` and `http` transports. It
does not preinstall a provider CLI or provider-specific adapter. External
adapters own their full runtime dependency and configuration contract.

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Notes:

- Paperclip does not inherit server-process provider credentials or
  provider-specific home variables into child processes.
- Prepare an external adapter's target-native configuration yourself and use
  only its explicit configuration schema.
- An incomplete target declaration blocks dispatch without a provider probe.

## Podman Quadlet (systemd)

The `docker/quadlet/` directory contains unit files to run Paperclip + PostgreSQL as systemd services via Podman Quadlet.

| File | Purpose |
|------|---------|
| `docker/quadlet/paperclip.pod` | Pod definition — groups containers into a shared network namespace |
| `docker/quadlet/paperclip.container` | Paperclip server — joins the pod, connects to Postgres at `127.0.0.1` |
| `docker/quadlet/paperclip-db.container` | PostgreSQL 17 — joins the pod, health-checked |

### Setup

1. Build the image (see above).

2. Copy quadlet files to your systemd directory:

   ```sh
   # Rootless (recommended)
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # Or rootful
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. Create a secrets env file (keep out of version control):

   ```sh
   cat > ~/.config/containers/systemd/paperclip.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=paperclip
   POSTGRES_PASSWORD=paperclip
   POSTGRES_DB=paperclip
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip
   EOL
   ```

4. Create the data directory and start:

   ```sh
   mkdir -p ~/.local/share/paperclip
   systemctl --user daemon-reload
   systemctl --user start paperclip-pod
   ```

### Quadlet management

```sh
journalctl --user -u paperclip -f        # App logs
journalctl --user -u paperclip-db -f     # DB logs
systemctl --user status paperclip-pod    # Pod status
systemctl --user restart paperclip-pod   # Restart all
systemctl --user stop paperclip-pod      # Stop all
```

### Quadlet notes

- **First boot**: Unlike Docker Compose's `condition: service_healthy`, Quadlet's `After=` only waits for the DB unit to *start*, not for PostgreSQL to be ready. On a cold first boot you may see one or two restart attempts in `journalctl --user -u paperclip` while PostgreSQL initialises — this is expected and resolves automatically via `Restart=on-failure`.
- Containers in a pod share `localhost`, so Paperclip reaches Postgres at `127.0.0.1:5432`.
- PostgreSQL data persists in the `paperclip-pgdata` named volume.
- Paperclip data persists at `~/.local/share/paperclip`.
- For rootful quadlet deployment, remove `%h` prefixes and use absolute paths.

## Release artifact validation

Release validation uses the canonical root `Dockerfile`. It builds the image and
inspects its metadata without starting a container or any runtime service:

```sh
docker build \
  --build-arg USER_UID="$(id -u)" \
  --build-arg USER_GID="$(id -g)" \
  -f Dockerfile \
  -t paperclip-release-artifact-smoke .
docker image inspect paperclip-release-artifact-smoke
```

The release contract suite is also artifact-only:

```sh
pnpm build
pnpm run test:release-smoke
```

It verifies shipped entrypoints, the production configuration's early failure
when no external database target is configured, and the server/client lifecycle
through mocks. It does not launch Paperclip, a container, or a database.

## General Notes

- The `docker-entrypoint.sh` adjusts the container `node` user UID/GID at startup to match the values passed via `USER_UID`/`USER_GID`, avoiding permission issues on bind-mounted volumes.
- Paperclip data persists via Docker volumes/bind mounts (compose) or at `~/.local/share/paperclip` (quadlet).
