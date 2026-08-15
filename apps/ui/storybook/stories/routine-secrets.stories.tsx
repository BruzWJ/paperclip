import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type {
  CompanySecret,
  EnvBinding,
  Routine,
  RoutineEnvConfig,
  RoutineRevision,
  RoutineRevisionSnapshotV1,
} from "@paperclipai/shared";
import { EnvironmentVariablesEditor } from "@/features/environment-variables-editor";
import { RoutineHistoryTab } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineHistoryTab";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import { storybookCompanies, storybookSecrets } from "../fixtures/paperclipData";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function StorybookRoutineFixtures({
  revisions,
  children,
}: {
  revisions: RoutineRevision[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), storybookSecrets);
  queryClient.setQueryData(queryKeys.routines.revisions("ffffffff-ffff-4fff-8fff-fffffffffff1"), revisions);

  return <>{children}</>;
}

const meta: Meta = {
  title: "Product/Routines · Secrets tab",
  parameters: {
    layout: "fullscreen",
    a11y: { test: "off" },
  },
};

export default meta;

type Story = StoryObj;

function SecretsTabSurface({
  initial,
  title,
}: {
  initial: RoutineEnvConfig | null;
  title: string;
}) {
  const [env, setEnv] = useState<Record<string, EnvBinding>>(() => (initial ?? {}) as Record<string, EnvBinding>);
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">
          The Secrets tab on a routine reuses the env-var editor and adds a one-line precedence helper.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Routine secrets apply to every task this routine creates. They override matching keys in
          project and agent env. <span className="font-mono">PAPERCLIP_*</span> variables are reserved.
        </p>
        <EnvironmentVariablesEditor
          value={env}
          secrets={storybookSecrets as CompanySecret[]}
          onCreateSecret={async (name) => ({
            ...storybookSecrets[0]!,
            id: `secret-${Math.random().toString(36).slice(2, 8)}`,
            name,
            key: name.toLowerCase(),
            description: `New routine secret ${name}`,
          })}
          onChange={(next) => setEnv((next ?? {}) as Record<string, EnvBinding>)}
        />
      </CardContent>
    </Card>
  );
}

export const SecretsTabEmpty: Story = {
  render: () => (
    <div className="space-y-6 p-6">
      <SecretsTabSurface
        title="Empty — no routine secrets configured"
        initial={null}
      />
    </div>
  ),
};

export const SecretsTabConfigured: Story = {
  render: () => (
    <div className="space-y-6 p-6">
      <SecretsTabSurface
        title="Configured — mix of secret refs and plain values"
        initial={{
          OPENAI_API_KEY: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000004", version: "latest" },
          STAGE: { type: "plain", value: "production" },
          GH_TOKEN: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000001", version: 2 },
        }}
      />
    </div>
  ),
};

export const SecretsTabDisabledOrMissing: Story = {
  render: () => (
    <div className="space-y-6 p-6">
      <SecretsTabSurface
        title="Bindings need attention — disabled secret + missing secret"
        initial={{
          OPENAI_API_KEY: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000004", version: "latest" },
          GITHUB_APP_PEM: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000003", version: "latest" },
          ABANDONED: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-00000000000c", version: "latest" },
        }}
      />
    </div>
  ),
};

function makeSnapshot(env: RoutineEnvConfig | null): RoutineRevisionSnapshotV1 {
  return {
    version: 1,
    routine: {
      id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      companyId: COMPANY_ID,
      projectId: null,
      goalId: null,
      parentTaskId: null,
      responsibleUserId: null,
      title: "Nightly digest",
      description: "Summarize agent activity each night.",
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      env,
    },
    triggers: [],
  };
}

function makeRoutine(latestRevisionId: string, latestRevisionNumber: number): Routine {
  return {
    id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
    companyId: COMPANY_ID,
    projectId: null,
    goalId: null,
    parentTaskId: null,
    responsibleUserId: null,
    title: "Nightly digest",
    description: "Summarize agent activity each night.",
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    env: makeSnapshot({
      OPENAI_API_KEY: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000004", version: "latest" },
      STAGE: { type: "plain", value: "production" },
    }).routine.env,
    latestRevisionId,
    latestRevisionNumber,
    createdByAgentId: null,
    createdByUserId: "a7000000-0000-4000-8000-000000000002",
    updatedByAgentId: null,
    updatedByUserId: "a7000000-0000-4000-8000-000000000002",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-05-01T11:00:00.000Z"),
    updatedAt: new Date("2026-05-04T12:00:00.000Z"),
  };
}

export const HistoryDiffWithEnv: Story = {
  name: "History diff — env keys added/removed/changed",
  render: () => {
    const revisions: RoutineRevision[] = [
      {
        id: "a2100000-0000-4000-8000-000000000004",
        companyId: COMPANY_ID,
        routineId: "ffffffff-ffff-4fff-8fff-fffffffffff1",
        revisionNumber: 2,
        title: "Nightly digest",
        description: "Summarize agent activity each night.",
        snapshot: makeSnapshot({
          OPENAI_API_KEY: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000004", version: "latest" },
          STAGE: { type: "plain", value: "production" },
        }),
        changeSummary: "Added STAGE plain value",
        restoredFromRevisionId: null,
        createdByAgentId: null,
        createdByUserId: "a7000000-0000-4000-8000-000000000002",
        createdByRunId: null,
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
      },
      {
        id: "a2100000-0000-4000-8000-000000000003",
        companyId: COMPANY_ID,
        routineId: "ffffffff-ffff-4fff-8fff-fffffffffff1",
        revisionNumber: 1,
        title: "Nightly digest",
        description: "Summarize agent activity each night.",
        snapshot: makeSnapshot({
          OPENAI_API_KEY: { type: "secret_ref", secretId: "a3000000-0000-4000-8000-000000000004", version: 2 },
          GH_TOKEN: { type: "plain", value: "retired" },
        }),
        changeSummary: "Created routine",
        restoredFromRevisionId: null,
        createdByAgentId: null,
        createdByUserId: "a7000000-0000-4000-8000-000000000002",
        createdByRunId: null,
        createdAt: new Date("2026-05-01T11:00:00.000Z"),
      },
    ];
    return (
      <StorybookRoutineFixtures revisions={revisions}>
        <div className="space-y-6 p-6">
          <RoutineHistoryTab
            routine={makeRoutine("a2100000-0000-4000-8000-000000000004", 2)}
            isEditDirty={false}
            dirtyFields={[]}
            onDiscardEdits={() => {}}
            onSaveEdits={() => {}}
            agents={new Map()}
            projects={new Map()}
            secrets={storybookSecrets as CompanySecret[]}
            onRestoreSecretMaterials={() => {}}
          />
        </div>
      </StorybookRoutineFixtures>
    );
  },
};
