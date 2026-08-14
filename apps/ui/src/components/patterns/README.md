# Kibo-backed application patterns

This directory is the single Paperclip-owned adapter layer between domain data
and shadcn/Kibo compositions. Screens should reuse these patterns instead of
recreating dialog, field, selector, status, upload, table, tree, diff, or code
block contracts.

The adapters intentionally keep business state and API mutations outside the
registry-owned `components/kibo-ui` directory:

- `EntityCombobox` composes Kibo Combobox for domain entity selection.
- `DataTable` composes Kibo Table with per-instance sorting state.
- `DomainTree`, `WorkTimelineGantt`, `DiffCodeBlock`, and `AccessibleDropzone`
  translate Paperclip contracts into Kibo Tree, Gantt, CodeBlock, and Dropzone.
- `DomainStatus`, `ZoomableImage`, `ThemeSelector`, and the color-picker
  adapters map domain values onto their exact Kibo components.
- `ConfirmActionDialog`, `LabeledFormField`, `SettingsSwitchField`, and
  `FormDialog` centralize repeated shadcn compositions using Kibo Patterns.
- `DetailList` centralizes the shadcn Item label/value metadata composition.
- `EntityCreationFields` combines the shared shadcn title field with the Kibo-backed editor.
- `PluginRouteBoundary` centralizes plugin-route loading and failure states with shadcn primitives.

The form layouts are adapted from the official Kibo Patterns examples
`field/layouts/field-layouts-6`, `dialog/standard/dialog-standard-6`, and
`dialog/standard/dialog-standard-7` at upstream commit
`3d63cdb15b79d972e3dc38a10997987672f9b263`. Kibo Patterns are source examples,
not a separately installable runtime component; keep this one shared
composition rather than copying an example into each feature.

Registry refreshes should update `components/kibo-ui` first, then verify these
adapters with their focused tests, UI typecheck, and `pnpm check:token-gates`.
