export type CompanyArtifactSource = "document" | "attachment" | "work_product";

export type CompanyArtifactMediaKind = "image" | "video" | "text" | "document" | "file" | "empty";

export type CompanyArtifactGroupBy = "none" | "task" | "parent_task";

export interface CompanyArtifactTaskSummary {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
}

export interface CompanyArtifactGroupTaskSummary {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
}

export interface CompanyArtifactProjectSummary {
  id: string;
  name: string;
}

export interface CompanyArtifactAgentSummary {
  id: string;
  name: string;
}

export interface CompanyArtifact {
  id: string;
  source: CompanyArtifactSource;
  mediaKind: CompanyArtifactMediaKind;
  title: string;
  previewText: string | null;
  contentType: string | null;
  contentPath: string | null;
  openPath: string | null;
  downloadPath: string | null;
  task: CompanyArtifactTaskSummary;
  project: CompanyArtifactProjectSummary | null;
  createdByAgent: CompanyArtifactAgentSummary | null;
  updatedAt: string;
  /** Hash fragment without the leading `#` for the canonical task route. */
  taskFragment: string;
}

export interface CompanyArtifactGroup {
  id: string;
  groupBy: Exclude<CompanyArtifactGroupBy, "none">;
  task: CompanyArtifactGroupTaskSummary;
  title: string;
  count: number;
  mediaKinds: CompanyArtifactMediaKind[];
  previewArtifacts: CompanyArtifact[];
  updatedAt: string;
}

export interface CompanyArtifactsResponse {
  artifacts: CompanyArtifact[];
  groups?: CompanyArtifactGroup[];
  selectedGroup?: CompanyArtifactGroup | null;
  nextCursor: string | null;
}
