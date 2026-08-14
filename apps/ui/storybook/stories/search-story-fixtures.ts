import type { CompanySearchResponse, CompanySearchResult } from "@paperclipai/shared";

import { storybookAgents, storybookProjects, storybookTasks } from "../fixtures/paperclipData";

export const agentsById = new Map(storybookAgents.map((agent) => [agent.id, agent]));

export type TaskResultOverrides = Omit<Partial<CompanySearchResult>, "task" | "routeTarget"> & {
  task?: Partial<NonNullable<CompanySearchResult["task"]>>;
  taskHash?: string | null;
};

export function buildTaskResult(overrides: TaskResultOverrides): CompanySearchResult {
  const baseTask = {
    id: overrides.task?.id ?? "dddddddd-dddd-4ddd-8ddd-ddddddddd009",
    taskNumber: overrides.task?.taskNumber ?? 3142,
    identifier: overrides.task?.identifier ?? "PAP-3142",
    title: overrides.task?.title ?? "Auth middleware flakes on cold-start when session token is rotated",
    request: overrides.task?.request ?? storybookTasks[0]?.request ?? "",
    boardPresentationStatus: overrides.task?.boardPresentationStatus ?? "in_progress",
    priority: overrides.task?.priority ?? "high",
    ownerAgentId: overrides.task?.ownerAgentId ?? storybookAgents[0]?.id ?? null,
    ownerUserId: overrides.task?.ownerUserId ?? null,
    projectId: overrides.task?.projectId ?? storybookProjects[0]?.id ?? null,
    updatedAt: overrides.task?.updatedAt ?? new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  } satisfies NonNullable<CompanySearchResult["task"]>;
  if (!baseTask.identifier) {
    throw new Error("Storybook search task fixtures require a canonical identifier");
  }
  return {
    id: overrides.id ?? baseTask.id,
    type: "task",
    score: 100,
    title: `${baseTask.identifier} ${baseTask.title}`,
    routeTarget: {
      kind: "task",
      taskNumber: baseTask.taskNumber,
      hash: overrides.taskHash ?? null,
    },
    matchedFields: overrides.matchedFields ?? ["title"],
    sourceLabel: overrides.sourceLabel ?? null,
    snippet: overrides.snippet ?? null,
    snippets: overrides.snippets ?? [],
    task: baseTask,
    updatedAt: baseTask.updatedAt,
    previewImageUrl: overrides.previewImageUrl ?? null,
  };
}

export const fixtureResults: CompanySearchResult[] = [
  buildTaskResult({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd009",
    matchedFields: ["title", "comment"],
    sourceLabel: "Comment",
    snippet: "we hit another flake in the morning batch — auth middleware",
    snippets: [
      {
        field: "title",
        label: "Title",
        text: "Auth middleware flakes on cold-start when session token is rotated",
        highlights: [{ start: 0, end: 4 }],
      },
      {
        field: "comment",
        label: "Comment",
        text: "we hit another flake in the morning batch — auth middleware ate the request",
        highlights: [
          { start: 16, end: 21 },
          { start: 47, end: 51 },
        ],
      },
    ],
  }),
  buildTaskResult({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00a",
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00a",
      identifier: "PAP-3091",
      title: "Audit auth flake telemetry from last quarter",
      boardPresentationStatus: "in_review",
      ownerAgentId: storybookAgents[1]?.id ?? null,
    },
    matchedFields: ["title", "document"],
    sourceLabel: "Document",
    snippet: "the deflake plan ranks auth regressions above latency tickets",
    snippets: [
      {
        field: "title",
        label: "Title",
        text: "Audit auth flake telemetry from last quarter",
        highlights: [{ start: 6, end: 10 }],
      },
      {
        field: "document",
        label: "PLAN",
        text: "the deflake plan ranks auth regressions above latency tickets",
        highlights: [
          { start: 12, end: 16 },
          { start: 26, end: 30 },
        ],
      },
    ],
    previewImageUrl:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23a78bfa'/><text x='50' y='55' font-size='14' fill='white' text-anchor='middle' font-family='sans-serif'>chart</text></svg>",
  }),
  buildTaskResult({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00b",
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00b",
      identifier: "PAP-2748",
      title: "Pin worker registration to a single auth backend",
      boardPresentationStatus: "done",
      ownerAgentId: null,
    },
    matchedFields: ["title", "identifier"],
    snippets: [
      {
        field: "title",
        label: "Title",
        text: "Pin worker registration to a single auth backend",
        highlights: [{ start: 36, end: 40 }],
      },
    ],
  }),
];

export const fixtureAgents: CompanySearchResult[] = storybookAgents.slice(0, 1).map((agent) => ({
  id: agent.id,
  type: "agent" as const,
  score: 80,
  title: agent.name,
  routeTarget: { kind: "agent", id: agent.id },
  matchedFields: ["agent"],
  sourceLabel: "Agent",
  snippet: agent.capabilities ?? null,
  snippets: agent.capabilities
    ? [
        {
          field: "capabilities",
          label: "Agent",
          text: agent.capabilities,
          highlights: [],
        },
      ]
    : [],
  updatedAt: new Date().toISOString(),
  previewImageUrl: null,
}));

export const fixtureProjects: CompanySearchResult[] = storybookProjects.slice(0, 1).map((project) => ({
  id: project.id,
  type: "project" as const,
  score: 70,
  title: project.name,
  routeTarget: { kind: "project", id: project.id },
  matchedFields: ["project"],
  sourceLabel: "Project",
  snippet: project.description ?? null,
  snippets: project.description
    ? [
        {
          field: "description",
          label: "Project",
          text: project.description,
          highlights: [],
        },
      ]
    : [],
  updatedAt: new Date().toISOString(),
  previewImageUrl: null,
}));

export const fixtureResponse: CompanySearchResponse = {
  query: "auth flake",
  normalizedQuery: "auth flake",
  scope: "all",
  limit: 20,
  offset: 0,
  sort: "relevance",
  results: [...fixtureResults, ...fixtureAgents, ...fixtureProjects],
  countsByType: {
    task: fixtureResults.length,
    comment: 0,
    document: 0,
    artifact: 0,
    agent: fixtureAgents.length,
    project: fixtureProjects.length,
  },
  filterOptionCounts: {
    status: {},
    priority: {},
    ownerAgentId: {},
    ownerUserId: {},
    projectId: {},
    labelId: {},
    updatedWithin: {},
  },
  zeroResults: null,
  hasMore: false,
};
