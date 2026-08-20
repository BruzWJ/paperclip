import { Schema } from "effect"
import { optional } from "./schema.js"
import { Prompt } from "./prompt.js"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema.js"
import { SessionID } from "./session-id.js"
import * as SessionMessage from "./session-message.js"

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })
