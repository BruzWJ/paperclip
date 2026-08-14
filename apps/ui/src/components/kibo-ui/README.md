# Kibo registry source

This directory is installed from the official Kibo registry at upstream commit
`3d63cdb15b79d972e3dc38a10997987672f9b263` and is excluded from Paperclip's
hand-authored token and file-size gates. Product behavior and styling belong in
adapters outside this directory.

Compatibility-only corrections from the generated registry output:

- `avatar-stack/index.tsx` includes native `div` attributes in its public prop
  contract, matching the attributes already forwarded by the generated source.
- `choicebox/index.tsx` maps Kibo's monorepo-only `@repo/shadcn-ui` imports to
  this app's standard `@/components/ui` and `@/lib/utils` aliases.
- `code-block/index.tsx` uses `SiCss` in place of the generated `SiCss3` name;
  `react-icons` 5.7 exports the former and not the latter.
- `dropzone/index.tsx` uses the generated presentation on a keyboard-operable
  `div` root. This avoids a file input nested in a button and prevents
  react-dropzone from exposing a focusable presentational button.
- `glimpse/index.tsx` maps Kibo's monorepo-only `@repo/shadcn-ui` utility
  import to this app's standard `@/lib/utils` alias.
- `editor/index.tsx` forwards Tiptap Suggestion's required `AbortSignal` and
  accepts optional slash-item and matcher providers. Kibo's providers remain
  the defaults; domain adapters can append commands or extend matching without
  installing a second slash Suggestion engine. Slash keyboard events stay with
  that engine's renderer so each event is handled once. Optional item IDs keep
  domain commands with duplicate display labels keyboard-distinguishable.
- `table/index.tsx` is kept byte-for-byte with the generated registry source;
  the app pins `@tanstack/react-table` to `^8.21.3` because that source uses the
  v8 provider and row-model API while the registry dependency is unversioned.
- `gantt/index.tsx` accepts opt-in `draggable={false}` feature items and an
  `initialExtent` provider hint. Kibo's defaults stay interactive and centered
  on today; read-only domain adapters can omit drag semantics and seed the
  calendar around historical or future data. Sidebar items also activate with
  Space as well as Enter when used through their generated `role="button"`.
- `kanban/index.tsx` accepts opt-in `draggable={false}` cards so read-only
  boards keep Kibo's card composition without exposing inactive sortable
  controls. Kibo's default remains draggable.
- `tree/index.tsx` accepts controlled `expandedIds` and an optional change
  callback so domain adapters can retain disclosure state without remounting
  Kibo's provider and losing keyboard focus.
- `status/index.tsx` disables the decorative ping animation when the user asks
  the operating system to reduce motion.

Default Kibo layout, styling, and interactions remain unchanged; additive hooks
only take effect when a domain adapter opts into them. Recheck every correction
whenever the components are refreshed through the Kibo CLI.
