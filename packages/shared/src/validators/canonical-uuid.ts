import { z } from "zod";
import { CANONICAL_UUID_RE } from "../canonical-uuid.js";

export const canonicalUuidSchema = z
  .string()
  .regex(CANONICAL_UUID_RE, "Expected an exact lowercase canonical UUID");
