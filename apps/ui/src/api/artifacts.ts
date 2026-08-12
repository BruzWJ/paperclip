import { api } from "./client";
import type {
  CompanyArtifactGroupBy,
  CompanyArtifactMediaKind,
  CompanyArtifactsResponse,
} from "@paperclipai/shared";

export type {
  CompanyArtifact,
  CompanyArtifactGroup,
  CompanyArtifactGroupBy as ArtifactGroupBy,
  CompanyArtifactsResponse,
} from "@paperclipai/shared";

/**
 * Company-level Artifacts client (PAP-10359).
 *
 * Talks to the company-scoped artifacts projection endpoint
 * (`GET /api/companies/:companyId/artifacts`) defined by the approved
 * Artifacts plan (PAP-10353). The endpoint flattens agent-produced task
 * documents, direct attachments, and `artifact` work products into a single
 * card-ready list so the UI never has to stitch task-specific endpoints
 * together.
 *
 * The `CompanyArtifact` shape is imported from `@paperclipai/shared` so the
 * frontend and server stay synchronized as the contract evolves.
 */

export type ArtifactKindFilter =
  Exclude<CompanyArtifactMediaKind, "empty"> | "all";

export interface ListArtifactsParams {
  kind?: ArtifactKindFilter;
  projectId?: string;
  q?: string;
  /** Grouping mode. `none` (default) returns the flat artifact grid. */
  groupBy?: CompanyArtifactGroupBy;
  /** When grouping, selects a single stack to expand into its artifacts. */
  groupTaskId?: string;
  limit?: number;
  cursor?: string;
}

function buildArtifactsQuery(params?: ListArtifactsParams): string {
  const search = new URLSearchParams();
  if (params?.kind && params.kind !== "all") search.set("kind", params.kind);
  if (params?.projectId) search.set("projectId", params.projectId);
  if (params?.q) search.set("q", params.q);
  if (params?.groupBy && params.groupBy !== "none")
    search.set("groupBy", params.groupBy);
  if (params?.groupTaskId) search.set("groupTaskId", params.groupTaskId);
  if (params?.limit != null) search.set("limit", String(params.limit));
  if (params?.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const artifactsApi = {
  list: (
    companyId: string,
    params?: ListArtifactsParams,
  ): Promise<CompanyArtifactsResponse> =>
    api.get<CompanyArtifactsResponse>(
      `/companies/${companyId}/artifacts${buildArtifactsQuery(params)}`,
    ),
};
