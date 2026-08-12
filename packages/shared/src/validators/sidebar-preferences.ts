import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import { canonicalUuidSchema } from "./canonical-uuid.js";

const sidebarOrderedIdsSchema = z
  .array(canonicalUuidSchema)
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        addValidationDetail(ctx, {
          message: "Sidebar order IDs must be unique",
          path: [index],
        });
      }
      seen.add(id);
    });
  });

export const sidebarOrderPreferenceSchema = z.strictObject({
  orderedIds: sidebarOrderedIdsSchema,
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.strictObject({
  orderedIds: sidebarOrderedIdsSchema,
});

export type UpsertSidebarOrderPreference = z.infer<
  typeof upsertSidebarOrderPreferenceSchema
>;
