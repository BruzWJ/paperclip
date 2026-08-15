import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CompanySecret,
  EnvBinding,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { MyUserSecretsTab } from "@/routes/_authenticated/$companyId/company/settings/secrets/-MyUserSecretsTab";
import { MissingUserSecretsBanner } from "@/routes/_authenticated/$companyId/-shell/-new-task/-MissingUserSecretsBanner";
import { EnvironmentVariablesEditor } from "@/routes/_authenticated/$companyId/-environment-variables-editor/-EnvironmentVariablesEditor";
import type { MyUserSecretEntry } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "storybook-user";

function makeDefinition(overrides: Partial<UserSecretDefinition>): UserSecretDefinition {
  return {
    id: "a4000000-0000-4000-8000-000000000006",
    companyId: COMPANY_ID,
    key: "USER_SECRET",
    name: "User secret",
    description: null,
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeValue(definitionId: string): CompanySecret {
  return {
    id: `sec-${definitionId}`,
    companyId: COMPANY_ID,
    scope: "user",
    ownerUserId: "a7000000-0000-4000-8000-000000000003",
    userSecretDefinitionId: definitionId,
    key: "USER_SECRET",
    name: "User secret",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "a7000000-0000-4000-8000-000000000003",
    createdAt: new Date("2026-06-02T00:00:00Z"),
    updatedAt: new Date("2026-06-02T00:00:00Z"),
  };
}

const ghToken = makeDefinition({
  id: "a4000000-0000-4000-8000-000000000001",
  key: "PERSONAL_GH_TOKEN",
  name: "Personal GitHub token",
  description: "Used when the responsible user's own repos must be reached.",
  usageGuidance: "Create a fine-grained PAT with repo:read scope.",
});
const openai = makeDefinition({
  id: "a4000000-0000-4000-8000-000000000002",
  key: "OPENAI_API_KEY",
  name: "OpenAI API key",
  description: "Each member bills to their own OpenAI account.",
});
const slack = makeDefinition({
  id: "a4000000-0000-4000-8000-000000000003",
  key: "SLACK_USER_TOKEN",
  name: "Slack user token",
  status: "disabled",
});

const definitions: UserSecretDefinition[] = [ghToken, openai, slack];

const coverage: Record<string, UserSecretCoverageSummary> = {
  "a4000000-0000-4000-8000-000000000001": { definitionId: "a4000000-0000-4000-8000-000000000001", configuredCount: 5, missingCount: 2, inactiveCount: 0 },
  "a4000000-0000-4000-8000-000000000002": { definitionId: "a4000000-0000-4000-8000-000000000002", configuredCount: 7, missingCount: 0, inactiveCount: 0 },
  "a4000000-0000-4000-8000-000000000003": { definitionId: "a4000000-0000-4000-8000-000000000003", configuredCount: 1, missingCount: 5, inactiveCount: 1 },
};

const myEntries: MyUserSecretEntry[] = [
  { definition: ghToken, secret: null },
  { definition: openai, secret: makeValue("a4000000-0000-4000-8000-000000000002") },
  { definition: slack, secret: null },
];

function SeedFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.secrets.userDefinitions(COMPANY_ID), definitions);
  queryClient.setQueryData(queryKeys.secrets.userSecrets(COMPANY_ID, USER_ID), myEntries);
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "storybook-session", userId: USER_ID },
    user: { id: USER_ID, name: "Storybook User", email: "storybook@example.com", image: null },
  });
  for (const [definitionId, summary] of Object.entries(coverage)) {
    queryClient.setQueryData(
      queryKeys.secrets.userDefinitionCoverage(COMPANY_ID, definitionId),
      summary,
    );
  }

  // The preview decorator already provides the memory router.
  return <>{children}</>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border p-6 last:border-b-0">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

const meta: Meta = {
  title: "Product/User secrets",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;
type Story = StoryObj;

export const MySecrets: Story = {
  render: () => (
    <SeedFixtures>
      <Section title="My secrets (owner)">
        <div className="h-[520px]">
          <MyUserSecretsTab companyId={COMPANY_ID} />
        </div>
      </Section>
    </SeedFixtures>
  ),
};

export const MissingWarning: Story = {
  render: () => (
    <SeedFixtures>
      <Section title="Missing user-secret warning (task creation / run)">
        <div className="max-w-xl">
          <MissingUserSecretsBanner companyId={COMPANY_ID} userId={USER_ID} />
        </div>
      </Section>
    </SeedFixtures>
  ),
};

export const EnvPicker: Story = {
  render: () => {
    const value: Record<string, EnvBinding> = {
      GH_TOKEN: { type: "user_secret_ref", key: "PERSONAL_GH_TOKEN", required: true },
      OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", required: false },
    };
    return (
      <SeedFixtures>
        <Section title="Env binding picker — User secret source">
          <div className="max-w-2xl">
            <EnvironmentVariablesEditor
              value={value}
              secrets={[]}
              userSecretDefinitions={definitions}
              onCreateSecret={async () => {
                throw new Error("noop");
              }}
              onChange={() => {}}
            />
          </div>
        </Section>
      </SeedFixtures>
    );
  },
};
