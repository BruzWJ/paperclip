# Plugin Authoring Smoke Example

A Paperclip plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm test
```

## Install Into Paperclip

```bash
pnpm paperclipai plugin install --local ./
```

From a Paperclip source checkout, an instance admin can also select this
example under **Instance settings → Plugins → Available Plugins**. The board
builds the workspace package before installing it.

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
