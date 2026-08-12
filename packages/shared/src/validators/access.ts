import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import {
  USER_COMPANY_MEMBERSHIP_ROLES,
  JOIN_REQUEST_STATUSES,
  PERMISSION_KEYS,
} from "../constants.js";

export const createCompanyInviteSchema = z.strictObject({
  userRole: z.enum(USER_COMPANY_MEMBERSHIP_ROLES).optional().nullable(),
});

export type CreateCompanyInvite = z.infer<typeof createCompanyInviteSchema>;

export const acceptInviteSchema = z.object({}).strict();

export type AcceptInvite = z.infer<typeof acceptInviteSchema>;

export const listJoinRequestsQuerySchema = z
  .object({
    status: z.enum(JOIN_REQUEST_STATUSES).optional(),
  })
  .strict();

export type ListJoinRequestsQuery = z.infer<typeof listJoinRequestsQuerySchema>;

export const approveJoinRequestSchema = z.object({}).strict();

export type ApproveJoinRequest = z.infer<typeof approveJoinRequestSchema>;

const exactPositiveQueryIntegerSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number);
const exactNonnegativeQueryIntegerSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .transform(Number);

export const listCompanyInvitesQuerySchema = z
  .object({
    state: z.enum(["active", "revoked", "accepted", "expired"]).optional(),
    limit: z.preprocess(
      (value) => (value === undefined ? "20" : value),
      exactPositiveQueryIntegerSchema.pipe(z.number().max(100)),
    ),
    offset: z.preprocess(
      (value) => (value === undefined ? "0" : value),
      exactNonnegativeQueryIntegerSchema,
    ),
  })
  .strict();

export type ListCompanyInvitesQuery = z.infer<
  typeof listCompanyInvitesQuerySchema
>;

export const boardCliAuthAccessLevelSchema = z.enum([
  "board",
  "instance_admin_required",
]);

export type BoardCliAuthAccessLevel = z.infer<
  typeof boardCliAuthAccessLevelSchema
>;

const exactNonBlankText = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim() === value, {
      message: "Value must not contain surrounding whitespace",
    });

const canonicalIsoDateTimeSchema = z
  .string()
  .datetime()
  .refine((value) => new Date(value).toISOString() === value, {
    message: "Timestamp must use canonical UTC ISO 8601 form",
  })
  .transform((value) => new Date(value));

export const createCliAuthChallengeSchema = z.strictObject({
  command: exactNonBlankText(240),
  clientName: exactNonBlankText(120).optional().nullable(),
  requestedAccess: boardCliAuthAccessLevelSchema.default("board"),
  requestedCompanyId: canonicalUuidSchema.optional().nullable(),
});

export type CreateCliAuthChallenge = z.infer<
  typeof createCliAuthChallengeSchema
>;

export const resolveCliAuthChallengeSchema = z.strictObject({
  token: z.string().min(16).max(256),
});

export type ResolveCliAuthChallenge = z.infer<
  typeof resolveCliAuthChallengeSchema
>;

export const createBoardApiKeySchema = z.strictObject({
  name: exactNonBlankText(120).default("paperclipai cli"),
  expiresAt: canonicalIsoDateTimeSchema.optional().nullable(),
  requestedCompanyId: canonicalUuidSchema.optional().nullable(),
});

export type CreateBoardApiKey = z.infer<typeof createBoardApiKeySchema>;

export const updateMemberPermissionsSchema = z.strictObject({
  grants: z.array(
    z.strictObject({
      permissionKey: z.enum(PERMISSION_KEYS),
      scope: z.record(z.string(), z.unknown()).optional().nullable(),
    }),
  ),
});

export type UpdateMemberPermissions = z.infer<
  typeof updateMemberPermissionsSchema
>;

const editableMembershipStatuses = ["pending", "active", "suspended"] as const;

export const updateCompanyMemberSchema = z
  .strictObject({
    membershipRole: z.enum(USER_COMPANY_MEMBERSHIP_ROLES).optional(),
    status: z.enum(editableMembershipStatuses).optional(),
  })
  .refine(
    (value) => value.membershipRole !== undefined || value.status !== undefined,
    {
      message: "membershipRole or status is required",
    },
  );

export type UpdateCompanyMember = z.infer<typeof updateCompanyMemberSchema>;

export const updateCompanyMemberWithPermissionsSchema = z
  .strictObject({
    membershipRole: z.enum(USER_COMPANY_MEMBERSHIP_ROLES).optional(),
    status: z.enum(editableMembershipStatuses).optional(),
    grants: updateMemberPermissionsSchema.shape.grants.default([]),
  })
  .refine(
    (value) => value.membershipRole !== undefined || value.status !== undefined,
    {
      message: "membershipRole or status is required",
    },
  );

export type UpdateCompanyMemberWithPermissions = z.infer<
  typeof updateCompanyMemberWithPermissionsSchema
>;

export const archiveCompanyMemberSchema = z.object({}).strict();

export type ArchiveCompanyMember = z.infer<typeof archiveCompanyMemberSchema>;

export const updateUserCompanyAccessSchema = z.strictObject({
  companyIds: z.array(canonicalUuidSchema).default([]),
});

export type UpdateUserCompanyAccess = z.infer<
  typeof updateUserCompanyAccessSchema
>;

export const searchAdminUsersQuerySchema = z
  .object({
    query: z
      .string()
      .max(120)
      .refine((value) => value.trim() === value)
      .optional()
      .default(""),
  })
  .strict();

export type SearchAdminUsersQuery = z.infer<typeof searchAdminUsersQuerySchema>;

const profileImageAssetPathPattern =
  /^\/api\/assets\/[^/?#]+\/content(?:\?[^#]*)?(?:#.*)?$/;

function isValidProfileImage(value: string): boolean {
  if (profileImageAssetPathPattern.test(value)) return true;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const profileImageSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.trim() === value, {
    message: "Profile image URL must not contain surrounding whitespace",
  })
  .refine(isValidProfileImage, { message: "Invalid profile image URL" });

export const authUserIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message:
      "User ID must be an exact non-empty value without surrounding whitespace",
  });

export const currentUserProfileSchema = z.object({
  id: authUserIdSchema,
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email().nullable(),
  ),
  name: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().min(1).max(120).nullable(),
  ),
  image: profileImageSchema.nullable(),
});

export type CurrentUserProfile = z.infer<typeof currentUserProfileSchema>;

export const authSessionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: authUserIdSchema,
  }),
  user: currentUserProfileSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const updateCurrentUserProfileSchema = z.strictObject({
  name: exactNonBlankText(120),
  image: z
    .union([profileImageSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value === "" ? null : value)),
});

export type UpdateCurrentUserProfile = z.infer<
  typeof updateCurrentUserProfileSchema
>;
