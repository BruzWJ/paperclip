# @paperclipai/create-paperclip-plugin

Scaffolding tool for creating new Paperclip plugins.

```bash
npx @paperclipai/create-paperclip-plugin my-plugin --category automation
```

Or with options:

```bash
npx @paperclipai/create-paperclip-plugin @acme/my-plugin \
  --category connector \
  --display-name "Acme Connector" \
  --description "Syncs Acme data into Paperclip" \
  --author "Acme Inc"
```

The generator produces one standard plugin structure for every category.

`--category` is required and accepts `connector`, `workspace`, `automation`,
or `ui`. These values come from the canonical plugin manifest contract.

Generates:
- typed manifest + worker entrypoint
- example UI widget using the supported `@paperclipai/plugin-sdk/ui` hooks
- test file using `@paperclipai/plugin-sdk/testing`
- an esbuild config using SDK bundler presets

The generated package is publishable and therefore does not set
`private: true`. Replace local SDK/shared tarball dependencies with published
versions before publishing an outside-repo scaffold.

The scaffold starts with plain React elements so the generated plugin stays minimal. For Paperclip-native controls, import shared host components such as `MarkdownEditor`, `FileTree`, `OwnerPicker`, and `ProjectPicker` from `@paperclipai/plugin-sdk/ui`.

Inside this repo, the generated package uses `@paperclipai/plugin-sdk` via `workspace:*`.

Outside this repo, the scaffold snapshots `@paperclipai/plugin-sdk` from your local Paperclip checkout into a `.paperclip-sdk/` tarball and points the generated package at that local file by default. You can override the SDK source explicitly:

```bash
pnpm paperclipai plugin init @acme/my-plugin \
  --category connector \
  --output /absolute/path/to/plugins \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

That gives you an outside-repo local development path before the SDK is published to npm.

## Workflow after scaffolding

```bash
cd my-plugin
pnpm install
pnpm dev       # watch worker + manifest + ui bundles
pnpm test
```
