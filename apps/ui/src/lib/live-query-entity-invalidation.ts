import type { ActivityLoggedLiveEventPayload } from "@paperclipai/shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const ROUTINE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS = new Set([
  "routine.document_annotation_thread_created",
  "routine.document_annotation_comment_added",
  "routine.document_annotation_thread_resolved",
  "routine.document_annotation_thread_reopened",
  "routine.document_annotation_remapped",
]);

export function invalidateEntityActivityQueries(
  queryClient: QueryClient,
  companyId: string,
  payload: ActivityLoggedLiveEventPayload,
  currentActor: { userId: string | null },
): void {
  const { action, actorId, actorType, details, entityId, entityType } = payload;
  const ownActorActivity = actorType === "user" && !!currentActor.userId && actorId === currentActor.userId;

  switch (entityType) {
    case "task":
      return;

    case "agent":
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: ["runs", companyId, entityId],
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeState(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeConfiguration(entityId, companyId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.adapterConfigRevisions(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.currentAdapterConfigRevisionRoot(entityId),
        });
      }
      return;

    case "agent_adapter_config_revision": {
      const targetAgentId = readString(details?.targetAgentId);
      if (targetAgentId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(targetAgentId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeConfiguration(targetAgentId, companyId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.adapterConfigRevisions(targetAgentId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.currentAdapterConfigRevisionRoot(targetAgentId),
        });
      }
      return;
    }

    case "project":
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(companyId),
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.detail(entityId),
        });
      }
      return;

    case "goal":
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(companyId),
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.detail(entityId),
        });
      }
      return;

    case "approval":
      queryClient.invalidateQueries({ queryKey: ["approvals", companyId] });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.detail(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.comments(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.tasks(entityId),
        });
      }
      return;

    case "join_request":
      queryClient.invalidateQueries({
        queryKey: ["access", "join-requests", companyId],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyMembers(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      return;

    case "invite":
      queryClient.invalidateQueries({
        queryKey: ["access", "invites", "paginated-v1", companyId],
      });
      return;

    case "company_membership":
    case "principal_permission_grants":
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyMembers(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["access", "current-board-access"],
      });
      queryClient.invalidateQueries({
        queryKey: ["access", "user-company-access"],
      });
      queryClient.invalidateQueries({ queryKey: ["user-profile", companyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      return;

    case "routine":
    case "routine_trigger":
    case "routine_run": {
      queryClient.invalidateQueries({
        queryKey: ["routines", companyId],
      });
      const routineId = entityType === "routine" ? entityId : readString(details?.routineId);
      if (routineId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routineId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.runs(routineId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.revisions(routineId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(companyId, routineId),
        });
        if (entityType === "routine" && action && ROUTINE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action)) {
          const documentKey = readString(details?.documentKey);
          if (documentKey) {
            queryClient.invalidateQueries({
              queryKey: ["routines", "document-annotations", routineId, documentKey],
              ...(ownActorActivity ? { refetchType: "inactive" as const } : undefined),
            });
          }
        }
      }
      queryClient.invalidateQueries({ queryKey: ["folders", companyId] });
      return;
    }

    case "folder":
      queryClient.invalidateQueries({ queryKey: ["folders", companyId] });
      return;

    case "company":
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companies.detail(companyId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      if (action?.startsWith("inbox.")) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.inboxDismissals(companyId),
        });
      }
      return;

    case "instance_settings":
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.settings });
      queryClient.invalidateQueries({
        queryKey: queryKeys.instance.generalSettings,
      });
      return;

    case "label":
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.labels(companyId),
      });
      return;

    case "secret": {
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["user-secrets", companyId],
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.usage(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.accessEvents(entityId),
        });
      }
      const definitionId = readString(details?.userSecretDefinitionId);
      if (definitionId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
        });
      }
      return;
    }

    case "secret_provider_config":
    case "secret_provider_config_discovery":
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.providers(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.providerConfigs(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["secret-provider-health", companyId],
      });
      return;

    case "user_secret_definition":
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.userDefinitions(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["user-secrets", companyId],
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, entityId),
        });
      }
      return;

    case "user":
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      queryClient.invalidateQueries({ queryKey: ["user-profile", companyId] });
      queryClient.invalidateQueries({ queryKey: ["access", "admin-users"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      return;

    case "user_inbox_agent_policy":
      queryClient.invalidateQueries({
        queryKey: entityId
          ? queryKeys.inboxAgentPolicy(companyId, entityId)
          : ["inbox-agent-policy", companyId],
      });
      return;

    case "plugin":
      return;

    case "asset":
      queryClient.invalidateQueries({ queryKey: ["artifacts", companyId] });
      return;

    case "budget_incident":
    case "budget_policy":
      queryClient.invalidateQueries({
        queryKey: queryKeys.budgets.overview(companyId),
      });
      return;

    case "execution_workspace":
    case "finance_event":
    case "local_run_lease":
      return;

    default:
      // Plugins may publish their own entity types. Aggregate and plugin cache
      // invalidations above remain canonical without inventing host aliases.
      return;
  }
}
