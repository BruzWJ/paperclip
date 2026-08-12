import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { isCanonicalUuid } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { goalsApi } from "@/api/goals";
import { projectsApi } from "@/api/projects";
import { routinesApi } from "@/api/routines";
import { runsApi } from "@/api/runs";
import { queryKeys } from "@/lib/queryKeys";

interface CompanyOwnedEntity {
  id: string;
  companyId: string;
}

export async function loadExactCompanyEntity<
  TEntity extends CompanyOwnedEntity,
>(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  companyId: string;
  entityId: string;
  fetchEntity: () => Promise<TEntity>;
}): Promise<TEntity> {
  const entity = await input.fetchEntity().catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) throw notFound();
    throw error;
  });

  if (entity.id !== input.entityId || entity.companyId !== input.companyId) {
    throw notFound();
  }

  input.queryClient.setQueryData(input.queryKey, entity);
  return entity;
}

interface CompanyEntityRouteLoaderInput {
  queryClient: QueryClient;
  companyId: string;
  entityId: string;
  signal: AbortSignal;
}

function assertCanonicalEntityId(entityId: string) {
  if (!isCanonicalUuid(entityId)) throw notFound();
}

export function loadCompanyAgent(input: CompanyEntityRouteLoaderInput) {
  assertCanonicalEntityId(input.entityId);
  return loadExactCompanyEntity({
    ...input,
    queryKey: queryKeys.agents.detail(input.entityId),
    fetchEntity: () => agentsApi.get(input.entityId, { signal: input.signal }),
  });
}

export function loadCompanyProject(input: CompanyEntityRouteLoaderInput) {
  assertCanonicalEntityId(input.entityId);
  return loadExactCompanyEntity({
    ...input,
    queryKey: queryKeys.projects.detail(input.entityId),
    fetchEntity: () =>
      projectsApi.get(input.entityId, { signal: input.signal }),
  });
}

export function loadCompanyApproval(input: CompanyEntityRouteLoaderInput) {
  assertCanonicalEntityId(input.entityId);
  return loadExactCompanyEntity({
    ...input,
    queryKey: queryKeys.approvals.detail(input.entityId),
    fetchEntity: () =>
      approvalsApi.get(input.entityId, { signal: input.signal }),
  });
}

export function loadCompanyGoal(input: CompanyEntityRouteLoaderInput) {
  assertCanonicalEntityId(input.entityId);
  return loadExactCompanyEntity({
    ...input,
    queryKey: queryKeys.goals.detail(input.entityId),
    fetchEntity: () => goalsApi.get(input.entityId, { signal: input.signal }),
  });
}

export function loadCompanyRoutine(input: CompanyEntityRouteLoaderInput) {
  assertCanonicalEntityId(input.entityId);
  return loadExactCompanyEntity({
    ...input,
    queryKey: queryKeys.routines.detail(input.entityId),
    fetchEntity: () =>
      routinesApi.get(input.entityId, { signal: input.signal }),
  });
}

export async function loadCompanyAgentRun(
  input: CompanyEntityRouteLoaderInput & { agentId: string },
) {
  assertCanonicalEntityId(input.entityId);
  assertCanonicalEntityId(input.agentId);
  const detail = await runsApi
    .get(input.entityId, 200, { signal: input.signal })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    });

  if (
    detail.run.id !== input.entityId ||
    detail.run.companyId !== input.companyId ||
    detail.run.targetAgentId !== input.agentId
  ) {
    throw notFound();
  }

  input.queryClient.setQueryData(queryKeys.runDetail(input.entityId), detail);
  return detail;
}
