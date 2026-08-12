import { Schema } from "effect"

export const ID = Schema.String.pipe(Schema.brand("SessionAgent.ID"))
export type ID = typeof ID.Type
