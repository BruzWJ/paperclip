import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { runtimeAgentCreateConfigurationSchema } from "./runtime-agent-configuration.js";
import { multilineTextSchema } from "./text.js";

const genericApprovalTypeSchema = z
  .enum(APPROVAL_TYPES)
  .refine((type) => type !== "hire_agent", {
    message:
      "hire_agent approvals are created only by the canonical runtime-agent transaction",
  });

export const createApprovalSchema = z.object({
  type: genericApprovalTypeSchema,
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
}).strict();

export type CreateApproval = z.infer<typeof createApprovalSchema>;

const hireAgentApprovalRunSourceSchema = z
  .object({
    kind: z.literal("agent_run"),
    issueId: z.string().uuid(),
    runId: z.string().uuid(),
    issueExecutionRefId: z.string().uuid(),
  })
  .strict();

const hireAgentApprovalPluginSourceSchema = z
  .object({
    kind: z.literal("plugin_control"),
    pluginInstallationId: z.string().uuid(),
  })
  .strict();

/**
 * Immutable link from a hire approval to the ordinary pending agent and the
 * exact runtime-agent configuration audit that created it. Configuration
 * bytes deliberately do not live in the approval payload and therefore cannot
 * be replayed at resolution time.
 */
export const hireAgentApprovalPayloadSchema = z
  .object({
    contract: z.literal("paperclip.hire-approval/v1"),
    agentId: z.string().uuid(),
    runtimeAgentConfigurationAuditId: z.string().uuid(),
    runtimeAgentConfigurationRequestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/),
    source: z.discriminatedUnion("kind", [
      hireAgentApprovalRunSourceSchema,
      hireAgentApprovalPluginSourceSchema,
    ]),
  })
  .strict();

export type HireAgentApprovalPayload = z.infer<
  typeof hireAgentApprovalPayloadSchema
>;

/**
 * A revision resubmission must name the exact immutable audit/digest being
 * replaced and provide the complete closed runtime-agent configuration.
 */
export const hireAgentApprovalResubmissionSchema = z
  .object({
    agentId: z.string().uuid(),
    runtimeAgentConfigurationAuditId: z.string().uuid(),
    runtimeAgentConfigurationRequestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/),
    configuration: runtimeAgentCreateConfigurationSchema,
  })
  .strict();

export type HireAgentApprovalResubmission = z.infer<
  typeof hireAgentApprovalResubmissionSchema
>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    hireAgent: hireAgentApprovalResubmissionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.payload !== undefined && value.hireAgent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payload and hireAgent are mutually exclusive",
      });
    }
  });

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
