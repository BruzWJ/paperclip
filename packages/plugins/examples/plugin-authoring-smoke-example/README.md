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

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
