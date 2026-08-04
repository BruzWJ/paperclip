import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  canonicalizeMoneyAmount,
  type Agent,
  type CatalogTeamImportPreviewResult,
  type CompanyPortabilityAdapterOverride,
  type CompanyPortabilityCollisionStrategy,
} from "@paperclipai/shared";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  ApplyProgress,
  ApplySuccess,
  StepAgentAdapters,
  StepPreview,
  StepSkillPlan,
  StepSourcePolicy,
  StepTargetManager,
  TeamCard,
  TeamDetailPane,
  TeamRow,
} from "@/pages/TeamCatalog";
import {
  currentInstalledState,
  onboardingTeams,
  optionalTeam,
  outOfDateInstalledState,
  sampleTeam as baseTeam,
  warnTeam,
} from "@/pages/TeamCatalog.fixtures";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { getUIAdapter } from "@/adapters";

// ---------------------------------------------------------------------------
// Fixtures
//
// Team fixtures (baseTeam/optionalTeam/warnTeam) are shared with the in-app
// /design-guide showcase via @/pages/TeamCatalog.fixtures so the two surfaces
// stay in sync. Preview/agent fixtures below are story-only.
// ---------------------------------------------------------------------------

const companyAgents: Agent[] = [
  makeAgent("agent-1", "Founder", "Founder"),
  makeAgent("agent-2", "Head of Eng", "Head of Engineering"),
  makeAgent("agent-3", "Ops Lead", "Operations Lead"),
];

function makeAgent(id: string, name: string, title: string): Agent {
  return {
    id,
    companyId: "company-storybook",
    name,
    urlKey: name.toLowerCase().replace(/\s+/g, "-"),
    title,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex" as Agent["adapterType"],
    adapterConfig: {},
    currentAdapterConfigRevisionId: null,
    runtimeConfig: {} as Agent["runtimeConfig"],
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    pauseReason: null,
    pausedAt: null,
    governance: {} as Agent["governance"],
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makePreview(errors: string[] = []): CatalogTeamImportPreviewResult {
  return {
    team: baseTeam,
    portabilityPreview: {
      include: { company: false, agents: true, projects: true, issues: false, skills: true },
      targetCompanyId: "company-storybook",
      targetCompanyName: "Paperclip",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["company-lead", "engineering-lead", "qa"],
      plan: {
        companyAction: "none",
        agentPlans: [
          { slug: "company-lead", action: "create", plannedName: "Company Lead", existingAgentId: null, reason: null },
          { slug: "engineering-lead", action: "create", plannedName: "Engineering Lead", existingAgentId: null, reason: null },
          { slug: "qa", action: "create", plannedName: "QA", existingAgentId: "agent-x", reason: "Renamed — name collision with existing agent" },
        ],
        projectPlans: [
          { slug: "launch", action: "create", plannedName: "Launch", existingProjectId: null, reason: null },
        ],
        issuePlans: [
          { slug: "kickoff", action: "skip", plannedTitle: "Kickoff", reason: "Starter tasks not selected" },
        ],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-06-03T00:00:00.000Z",
        source: null,
        includes: { company: false, agents: true, projects: true, issues: false, skills: true },
        company: null,
        sidebar: null,
        agents: [
          manifestAgent("company-lead", "Company Lead"),
          manifestAgent("engineering-lead", "Engineering Lead"),
          manifestAgent("qa", "QA"),
        ],
        skills: [],
        projects: [],
        issues: [],
        envInputs: [],
      },
      files: {},
      envInputs: [
        { key: "OPENAI_API_KEY", description: "API key for the launch project", projectSlug: "launch", kind: "secret", requirement: "required", defaultValue: null, portability: "portable" },
        { key: "DEFAULT_TIMEZONE", description: "Project timezone", projectSlug: "launch", kind: "plain", requirement: "optional", defaultValue: "UTC", portability: "portable" },
      ],
      warnings: ["Skill acme/growth-playbook will be imported from an external GitHub source."],
      errors,
    },
    skillPreparations: [
      { type: "catalog", ref: "engineering/code-review", agentSlugs: [], action: "already_in_package", catalogSkillId: "skill-1", catalogSkillKey: "engineering/code-review", sourceLocator: null, sourceRef: null, reason: null },
      { type: "github", ref: "acme/growth-playbook@v1.2.0", agentSlugs: [], action: "external_import_required", catalogSkillId: null, catalogSkillKey: null, sourceLocator: "github.com/acme/growth-playbook", sourceRef: "v1.2.0", reason: "Resolved from GitHub at install time" },
    ],
    warnings: [],
    errors,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function manifestAgent(slug: string, name: string): any {
  return {
    slug, name, path: `agents/${slug}/AGENTS.md`, skills: [], title: null, icon: null,
    capabilities: null, reportsToSlug: slug === "company-lead" ? null : "company-lead", adapterType: "codex",
    adapterConfig: {}, runtimeConfig: {}, governance: {}, budgetMonthlyAmount: "0", metadata: null,
  };
}

const noop = () => {};

function Frame({ children, width = "max-w-3xl" }: { children: React.ReactNode; width?: string }) {
  return <div className={`mx-auto w-full ${width} rounded-lg border border-border bg-background p-5`}>{children}</div>;
}

const meta: Meta = {
  title: "Surfaces/Team Catalog",
};
export default meta;
type Story = StoryObj;

export const BrowseList: Story = {
  render: () => (
    <div className="w-[28rem] border border-border">
      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bundled · 1</div>
      <TeamRow team={baseTeam} selected onSelect={noop} />
      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Optional · 2</div>
      <TeamRow team={optionalTeam} selected={false} onSelect={noop} />
      <TeamRow team={warnTeam} selected={false} onSelect={noop} />
    </div>
  ),
};

export const DetailPane: Story = {
  render: () => (
    <div className="h-[760px] overflow-hidden border border-border">
      <TeamDetailPane
        team={baseTeam}
        selectedPath={null}
        onSelectFile={noop}
        onInstall={noop}
        canInstall
        fileContent={null}
      />
    </div>
  ),
};

// PAP-10256: installed/out-of-date surface driven by the server signal.
export const InstalledStates: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="w-[28rem] border border-border">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bundled · 1</div>
        <TeamRow team={optionalTeam} selected={false} onSelect={noop} />
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Installed · 2</div>
        <TeamRow team={baseTeam} selected onSelect={noop} installed={outOfDateInstalledState} />
        <TeamRow team={warnTeam} selected={false} onSelect={noop} installed={currentInstalledState} />
      </div>
      <div className="h-[760px] overflow-hidden border border-border">
        <TeamDetailPane
          team={baseTeam}
          selectedPath={null}
          onSelectFile={noop}
          onInstall={noop}
          canInstall
          fileContent={null}
          installed={outOfDateInstalledState}
        />
      </div>
    </div>
  ),
};

export const InstallTargetManager: Story = {
  render: function Render() {
    const [managerId, setManagerId] = useState<string | null>(null);
    const [fullCompany, setFullCompany] = useState(false);
    return (
      <Frame>
        <StepTargetManager
          team={baseTeam}
          agents={companyAgents}
          targetManagerAgentId={managerId}
          onPickManager={setManagerId}
          fullCompany={fullCompany}
          onToggleFullCompany={setFullCompany}
          canBypassManager
        />
      </Frame>
    );
  },
};

export const InstallSourcePolicy: Story = {
  render: function Render() {
    const [ext, setExt] = useState(false);
    const [unpinned, setUnpinned] = useState(false);
    const [local, setLocal] = useState(false);
    return (
      <Frame>
        <StepSourcePolicy
          team={warnTeam}
          allowExternalSources={ext}
          allowUnpinnedOptionalSources={unpinned}
          allowLocalPathSources={local}
          onChange={(key, v) => {
            if (key === "external") setExt(v);
            if (key === "unpinned") setUnpinned(v);
            if (key === "localPath") setLocal(v);
          }}
        />
      </Frame>
    );
  },
};

export const InstallSkillPlan: Story = {
  render: () => (
    <Frame>
      <StepSkillPlan team={baseTeam} preparations={makePreview().skillPreparations} />
    </Frame>
  ),
};

export const InstallAgentAdapters: Story = {
  render: function Render() {
    const [adapters, setAdapters] = useState<
      Record<string, CompanyPortabilityAdapterOverride>
    >({});
    const [configValues, setConfigValues] = useState<
      Record<string, CreateConfigValues>
    >({});
    return (
      <Frame>
        <StepAgentAdapters
          companyId="11111111-1111-4111-8111-111111111111"
          team={baseTeam}
          adapterOverrides={adapters}
          configValues={configValues}
          onAdapterChange={(slug, adapterType) => {
            const values = { ...defaultCreateValues, adapterType };
            setConfigValues((current) => ({ ...current, [slug]: values }));
            setAdapters((current) => ({
              ...current,
              [slug]: {
                adapterType,
                adapterConfig:
                  getUIAdapter(adapterType).buildAdapterConfig(values),
                defaultEnvironmentId:
                  values.defaultEnvironmentId ?? "",
                skillChannel: "operator_native",
              },
            }));
          }}
          onConfigChange={(slug, patch) => {
            const adapterType = adapters[slug]?.adapterType;
            if (!adapterType) return;
            const values = {
              ...(configValues[slug] ?? {
                ...defaultCreateValues,
                adapterType,
              }),
              ...patch,
              adapterType,
            };
            setConfigValues((current) => ({ ...current, [slug]: values }));
            setAdapters((current) => ({
              ...current,
              [slug]: {
                adapterType,
                adapterConfig:
                  getUIAdapter(adapterType).buildAdapterConfig(values),
                defaultEnvironmentId:
                  values.defaultEnvironmentId ?? "",
                skillChannel: adapters[slug]!.skillChannel,
              },
            }));
          }}
          onConfigurationReadyChange={() => undefined}
        />
      </Frame>
    );
  },
};

export const InstallPreview: Story = {
  render: function Render() {
    const [collision, setCollision] = useState<CompanyPortabilityCollisionStrategy>("rename");
    const [names, setNames] = useState<Record<string, string>>({});
    return (
      <Frame>
        <StepPreview
          team={baseTeam}
          loading={false}
          error={null}
          result={makePreview()}
          collisionStrategy={collision}
          onCollisionStrategyChange={setCollision}
          nameOverrides={names}
          onRename={(slug, name) => setNames((c) => ({ ...c, [slug]: name }))}
          onRetry={noop}
        />
      </Frame>
    );
  },
};

export const InstallPreviewBlocked: Story = {
  render: () => (
    <Frame>
      <StepPreview
        team={baseTeam}
        loading={false}
        error={null}
        result={makePreview(["Target manager is required before this team can be installed.", "Skill acme/growth-playbook is blocked by source policy."])}
        collisionStrategy="rename"
        onCollisionStrategyChange={noop}
        nameOverrides={{}}
        onRename={noop}
        onRetry={noop}
      />
    </Frame>
  ),
};

export const InstallApplyProgress: Story = {
  render: () => (
    <Frame>
      <ApplyProgress team={baseTeam} />
    </Frame>
  ),
};

// Onboarding seam (design §6 + §12.5): the TeamCard tile rendered in the
// 3-col "Pick a starter team" grid, with the first defaultInstall tile selected.
export const OnboardingTeamGrid: Story = {
  render: function Render() {
    const [selectedId, setSelectedId] = useState(onboardingTeams[0]?.id ?? null);
    return (
      <Frame width="max-w-2xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Pick a starter team</h2>
          <p className="text-sm text-muted-foreground">
            We&apos;ll set up agents, projects, and routines so you can start with a working team.
          </p>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {onboardingTeams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              selected={team.id === selectedId}
              onSelect={() => setSelectedId(team.id)}
            />
          ))}
        </div>
      </Frame>
    );
  },
};

// A single TeamCard in its selected state.
export const TeamCardSelected: Story = {
  render: () => (
    <div className="mx-auto w-64">
      <TeamCard team={onboardingTeams[0]} selected onSelect={noop} />
    </div>
  ),
};

export const InstallSuccess: Story = {
  render: () => (
    <Frame>
      <ApplySuccess
        team={baseTeam}
        result={{
          team: baseTeam,
          portabilityImport: {
            company: { id: "company-storybook", name: "Paperclip", action: "unchanged" },
            agents: [
              { slug: "company-lead", id: "a1", action: "created", name: "Company Lead", reason: null },
              { slug: "engineering-lead", id: "a2", action: "created", name: "Engineering Lead", reason: null },
              { slug: "qa", id: "a3", action: "created", name: "QA", reason: null },
            ],
            projects: [{ slug: "launch", id: "p1", action: "created", name: "Launch", reason: null }],
            envInputs: [],
            warnings: [],
          },
          skillPreparations: makePreview().skillPreparations,
          warnings: ["Skill acme/growth-playbook imported from GitHub — review pinned ref."],
        }}
        onClose={noop}
      />
    </Frame>
  ),
};
