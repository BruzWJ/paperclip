import { Schema } from "effect"
import { AbsolutePath, optional } from "./schema.js"
import { WorkspaceID } from "./workspace-id.js"

export interface Ref extends Schema.Schema.Type<typeof Ref> {}
export const Ref = Schema.Struct({
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceID),
}).annotate({ identifier: "Location.Ref" })
