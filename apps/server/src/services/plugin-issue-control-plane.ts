import { issues, type Db } from "@paperclipai/db";
import type { Issue } from "@paperclipai/shared";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { PluginIssueControlPlane } from "./plugin-host-services.js";
import type { OrdinaryIssueRuntime } from "./ordinary-issue-runtime.js";
import { issueService } from "./issues.js";

function requireIssue(
  issue: Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>>,
  message: string,
): Issue {
  if (!issue) throw new Error(message);
  return issue as Issue;
}

function pluginIssueRpcIdempotencyKey(
  method: "issues.create" | "issues.update",
  params: {
    pluginInstallationId: string;
    hostRpcOperationId: string;
  },
): string {
  const hostRpcOperationId = params.hostRpcOperationId.trim();
  if (!hostRpcOperationId) {
    throw new Error("Host RPC operation identity is required");
  }
  return [
    "plugin-issue-rpc",
    params.pluginInstallationId,
    method,
    hostRpcOperationId,
  ].join(":");
}

/**
 * Installation-bound implementation of the retained plugin issue control
 * plane. Reads are company-scoped. Mutations additionally prove immutable
 * plugin creator identity inside OrdinaryIssueRuntime.
 */
export function createPluginIssueControlPlane(
  db: Db,
  ordinaryIssues: OrdinaryIssueRuntime,
): PluginIssueControlPlane {
  const issueReads = issueService(db);

  return {
    async list(params) {
      const conditions: SQL[] = [
        eq(issues.companyId, params.companyId),
        isNull(issues.hiddenAt),
      ];
      if (params.projectId) {
        conditions.push(eq(issues.projectId, params.projectId));
      }
      if (params.ownerAgentId) {
        conditions.push(eq(issues.ownerAgentId, params.ownerAgentId));
      }
      if (params.status) {
        conditions.push(eq(issues.lifecycleStatus, params.status));
      }
      const offset = Math.max(0, Math.floor(params.offset ?? 0));
      const limit = Math.max(1, Math.min(1_000, Math.floor(params.limit ?? 500)));
      const ids = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(...conditions))
        .orderBy(desc(issues.updatedAt), desc(issues.id))
        .limit(limit)
        .offset(offset);
      const rows = await Promise.all(ids.map(({ id }) => issueReads.getById(id)));
      return rows.filter((issue): issue is NonNullable<typeof issue> => issue !== null) as Issue[];
    },

    async get(params) {
      const issue = await issueReads.getById(params.issueId);
      return issue?.companyId === params.companyId ? issue as Issue : null;
    },

    async create(params) {
      const created = await ordinaryIssues.create({
        companyId: params.companyId,
        request: params.request,
        ownerAgentId: params.ownerAgentId,
        creator: {
          kind: "plugin",
          pluginInstallationId: params.pluginInstallationId,
          pluginKey: params.pluginKey,
          callbackKey: params.callbackKey,
          callbackVersion: params.callbackVersion,
          callbackRegistrationActive: params.callbackRegistrationActive,
        },
        idempotencyKey: pluginIssueRpcIdempotencyKey("issues.create", params),
        sourceKind: "issue_request",
        title: params.title,
        projectId: params.projectId,
        goalId: params.goalId,
        parentId: params.parentId,
        priority: params.priority as
          | "critical"
          | "high"
          | "medium"
          | "low"
          | undefined,
        contextAccessMask: params.contextAccessMask,
      });
      return requireIssue(
        await issueReads.getById(created.issue.id),
        "Created plugin issue could not be read",
      );
    },

    async update(params) {
      if (params.input.kind === "message") {
        const updated = await ordinaryIssues.commitCreatorFormUpdate(
          params.issueId,
          params.input.message,
          {
            kind: "plugin",
            companyId: params.companyId,
            pluginInstallationId: params.pluginInstallationId,
            pluginKey: params.pluginKey,
            gatewayInvocationId: pluginIssueRpcIdempotencyKey(
              "issues.update",
              params,
            ),
          },
        );
        return requireIssue(
          await issueReads.getById(updated.update.issueId),
          "Updated plugin issue could not be read",
        );
      }

      const reassigned = await ordinaryIssues.reassign({
        companyId: params.companyId,
        issueId: params.issueId,
        ownerAgentId: params.input.ownerAgentId,
        idempotencyKey: pluginIssueRpcIdempotencyKey("issues.update", params),
        creator: {
          kind: "plugin",
          pluginInstallationId: params.pluginInstallationId,
          pluginKey: params.pluginKey,
        },
      });
      return requireIssue(
        await issueReads.getById(reassigned.issue.id),
        "Reassigned plugin issue could not be read",
      );
    },

    async withdraw(params) {
      await ordinaryIssues.preparePluginWithdrawal({
        companyId: params.companyId,
        issueId: params.issueId,
        message: params.message,
        operationId: params.hostRpcOperationId,
        pluginInstallationId: params.pluginInstallationId,
        pluginKey: params.pluginKey,
      });
      const result = await ordinaryIssues.withdrawPluginIssue({
        companyId: params.companyId,
        operationId: params.hostRpcOperationId,
        pluginInstallationId: params.pluginInstallationId,
        pluginKey: params.pluginKey,
      });
      return {
        operationId: result.operationId,
        issue: result.issue as Issue,
        retried: result.retried,
      };
    },
  };
}
