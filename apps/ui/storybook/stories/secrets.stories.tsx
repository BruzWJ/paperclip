import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { AlertCircle, KeyRound } from "lucide-react";
import type {
  CompanySecret,
  EnvBinding,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { Route as SecretsRoute } from "@/routes/_authenticated/$companyId/company/settings/secrets";
import { getRouteComponent } from "@/test/route-component";
import {
  SecretBindingPicker,
  type SecretBindingValue,
} from "@/routes/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/-json-schema/-SecretBindingPicker";
import { EnvironmentVariablesEditor } from "@/routes/_authenticated/$companyId/-environment-variables-editor/-EnvironmentVariablesEditor";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/queryKeys";
import { storybookSecrets } from "../fixtures/paperclipData";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "storybook-user";
const Secrets = getRouteComponent(SecretsRoute);

const storybookUserSecretDefinitions: UserSecretDefinition[] = [
  {
    id: "a4000000-0000-4000-8000-000000000004",
    companyId: COMPANY_ID,
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    description: "Used when the responsible user's own repos must be reached.",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: "Create a fine-grained PAT with repo read access.",
    createdByAgentId: null,
    createdByUserId: "a7000000-0000-4000-8000-000000000002",
    updatedByAgentId: null,
    updatedByUserId: "a7000000-0000-4000-8000-000000000002",
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  },
  {
    id: "a4000000-0000-4000-8000-000000000005",
    companyId: COMPANY_ID,
    key: "USER_OPENAI_API_KEY",
    name: "User OpenAI API key",
    description: "Each member bills agent experiments to their own account.",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: "Create a project-scoped OpenAI key.",
    createdByAgentId: null,
    createdByUserId: "a7000000-0000-4000-8000-000000000002",
    updatedByAgentId: null,
    updatedByUserId: "a7000000-0000-4000-8000-000000000002",
    deletedAt: null,
    createdAt: new Date("2026-06-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-04T00:00:00.000Z"),
  },
];

const storybookUserSecretCoverage: Record<string, UserSecretCoverageSummary> = {
  "a4000000-0000-4000-8000-000000000004": {
    definitionId: "a4000000-0000-4000-8000-000000000004",
    configuredCount: 5,
    missingCount: 2,
    inactiveCount: 0,
  },
  "a4000000-0000-4000-8000-000000000005": {
    definitionId: "a4000000-0000-4000-8000-000000000005",
    configuredCount: 7,
    missingCount: 0,
    inactiveCount: 0,
  },
};

function StorybookSecretsFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Seed query caches synchronously so children hydrate from cache on first render.
  queryClient.setQueryData(
    queryKeys.secrets.list(COMPANY_ID),
    storybookSecrets,
  );
  queryClient.setQueryData(
    queryKeys.secrets.userDefinitions(COMPANY_ID),
    storybookUserSecretDefinitions,
  );
  queryClient.setQueryData(
    queryKeys.secrets.userSecrets(COMPANY_ID, USER_ID),
    storybookUserSecretDefinitions.map((definition) => ({
      definition,
      secret: null,
    })),
  );
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "storybook-session", userId: USER_ID },
    user: {
      id: USER_ID,
      name: "Storybook User",
      email: "storybook@example.com",
      image: null,
    },
  });
  for (const [definitionId, summary] of Object.entries(
    storybookUserSecretCoverage,
  )) {
    queryClient.setQueryData(
      queryKeys.secrets.userDefinitionCoverage(COMPANY_ID, definitionId),
      summary,
    );
  }

  const onSecretsRoute =
    location.pathname ===
    "/11111111-1111-4111-8111-111111111111/company/settings/secrets";
  useEffect(() => {
    if (!onSecretsRoute) {
      void navigate({
        to: "/$companyId/company/settings/secrets",
        params: { companyId: "11111111-1111-4111-8111-111111111111" },
        replace: true,
      });
    }
  }, [navigate, onSecretsRoute]);

  // Block render until the company id is the storybook fixture so the BindingPicker's
  // useQuery never sees the production-like null state.
  if (!onSecretsRoute) {
    return null;
  }

  return <>{children}</>;
}

const meta: Meta = {
  title: "Product/Secrets",
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "off",
    },
  },
};

export default meta;

type Story = StoryObj;

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border pb-8 last:border-b-0">
      <header className="mb-3 px-6 pt-6">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      </header>
      <div className="px-6">{children}</div>
    </section>
  );
}

export const SecretsInventory: Story = {
  render: () => (
    <StorybookSecretsFixtures>
      <div className="h-screen w-full bg-background">
        <Secrets />
      </div>
    </StorybookSecretsFixtures>
  ),
};

function BindingPickerSurface({
  initial,
  label,
}: {
  initial: SecretBindingValue | null;
  label: string;
}) {
  const [value, setValue] = useState<SecretBindingValue | null>(initial);
  return (
    <Card className="w-96">
      <CardHeader>
        <CardTitle className="text-sm">{label}</CardTitle>
        <CardDescription className="text-xs">
          Picker can be reused across agent, project, environment, and plugin
          config surfaces.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <SecretBindingPicker value={value} onChange={setValue} />
        <pre className="rounded bg-muted/40 p-2 text-[11px] font-mono">
          {JSON.stringify(value, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}

export const BindingPicker: Story = {
  render: () => {
    return (
      <StorybookSecretsFixtures>
        <div className="grid grid-cols-1 gap-6 p-6 md:grid-cols-2">
          <BindingPickerSurface initial={null} label="Empty state" />
          <BindingPickerSurface
            initial={{ secretId: storybookSecrets[0]!.id, version: "latest" }}
            label="Bound to active secret"
          />
          <BindingPickerSurface
            initial={{ secretId: storybookSecrets[2]!.id, version: "latest" }}
            label="Bound but disabled"
          />
          <BindingPickerSurface
            initial={{
              secretId: "a3000000-0000-4000-8000-00000000000c",
              version: "latest",
            }}
            label="Bound to missing secret"
          />
        </div>
      </StorybookSecretsFixtures>
    );
  },
};

export const EnvEditorWithSecrets: Story = {
  render: () => {
    function EditorDemo({
      initial,
      label,
    }: {
      initial: Record<string, EnvBinding>;
      label: string;
    }) {
      const [env, setEnv] = useState<Record<string, EnvBinding>>(initial);
      return (
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5" />
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EnvironmentVariablesEditor
              value={env}
              secrets={storybookSecrets as CompanySecret[]}
              onCreateSecret={async (name, value) => ({
                ...storybookSecrets[0]!,
                id: `secret-${Math.random().toString(36).slice(2, 8)}`,
                name,
                key: name.toLowerCase(),
                description: `New secret with value len=${value.length}`,
              })}
              onChange={(next) => setEnv(next ?? {})}
            />
          </CardContent>
        </Card>
      );
    }
    return (
      <div className="space-y-6 p-6">
        <EditorDemo
          label="Healthy bindings"
          initial={{
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: "a3000000-0000-4000-8000-000000000004",
              version: "latest",
            },
            STAGE: { type: "plain", value: "production" },
          }}
        />
        <EditorDemo
          label="Mixed bindings (some need attention)"
          initial={{
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: "a3000000-0000-4000-8000-000000000004",
              version: 2,
            },
            GITHUB_APP_PEM: {
              type: "secret_ref",
              secretId: "a3000000-0000-4000-8000-000000000003",
              version: "latest",
            },
            ABANDONED: {
              type: "secret_ref",
              secretId: "a3000000-0000-4000-8000-00000000000c",
              version: "latest",
            },
          }}
        />
      </div>
    );
  },
};

export const RunFailureCopy: Story = {
  render: () => (
    <div className="space-y-4 p-6">
      <Section
        eyebrow="Run failure"
        title="Missing or disabled secret blocks the run"
      >
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <Badge
                variant="outline"
                className="border-destructive/40 text-destructive"
              >
                Run failed
              </Badge>
              <span className="text-xs font-mono text-muted-foreground">
                PAP-2350 · 90000000-0000-4000-8000-000000000001
              </span>
            </div>
            <CardTitle className="text-sm">
              Secret <span className="font-mono">OPENAI_API_KEY</span> is{" "}
              <span className="font-medium text-destructive">disabled</span>
            </CardTitle>
            <CardDescription className="text-xs">
              The agent tried to resolve{" "}
              <span className="font-mono">env.OPENAI_API_KEY</span> for{" "}
              <span className="font-mono">agent:CodexCoder</span> but the secret
              is currently disabled. No value was loaded, no run logs were
              emitted that contained secret material.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <p className="text-muted-foreground">Next action</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>
                  Re-enable the secret on{" "}
                  <Link
                    to="/$companyId/company/settings/secrets"
                    params={{
                      companyId: "11111111-1111-4111-8111-111111111111",
                    }}
                    className="text-primary underline"
                  >
                    Company settings &gt; Secrets
                  </Link>
                </li>
                <li>
                  Or, rotate to a new value and pin v3 explicitly for this
                  agent.
                </li>
                <li>
                  Or, swap the binding to a different secret with the binding
                  picker.
                </li>
              </ul>
            </div>
            <div>
              <p className="text-muted-foreground">Audit</p>
              <p className="font-mono text-[11px]">
                secret_access_events.outcome=failure error=secret_disabled
                consumer=agent:CodexCoder
              </p>
            </div>
          </CardContent>
        </Card>
      </Section>
    </div>
  ),
};
