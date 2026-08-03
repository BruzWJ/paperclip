---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker with an external PostgreSQL service.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

The quickstart includes an application container and a PostgreSQL service.
Defaults:

- Host port: `3100`
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Manual Docker Build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e DATABASE_URL=postgres://paperclip:paperclip@host.docker.internal:5432/paperclip \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Data Persistence

Application-managed data is persisted under the bind mount (`./data/docker-paperclip`):

- Uploaded assets
- Local secrets key
- Agent workspace data

## Agent transports in Docker

The Paperclip image contains the canonical `process` and `http` transports. It
does not install provider CLIs or provider-specific adapter packages. Install
an external adapter separately and provide its executable in the declared
execution target.

Provider credentials are not server-level Docker environment variables.
Prepare provider-native configuration inside the declared execution target:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e DATABASE_URL=postgres://paperclip:paperclip@host.docker.internal:5432/paperclip \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Paperclip does not inherit provider credential, model, or home variables from the
server container and does not import a host provider home into the container.
Mount or provision target-native configuration yourself, then record only its
opaque target locator/revision in Paperclip.

An agent without a structurally complete target declaration remains paused
until an operator configures and resumes it.
