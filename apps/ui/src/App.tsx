import { Suspense } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { Layout } from "./components/Layout";
import { AuthenticatedAppGate } from "./components/AuthenticatedAppGate";
// NotFoundPage stays eager on purpose: Layout already imports it statically for
// the invalid-company-prefix state, so it is in the entry graph either way.
import { NotFoundPage } from "./pages/NotFound";
import { useCompany } from "./context/CompanyContext";
import { useDialogActions, useDialogState } from "./context/DialogContext";
import { AGENT_FILTER_TABS } from "./lib/agent-filter-tabs";
import { loadLastInboxTab } from "./lib/inbox";
import { lazyPage } from "./lib/lazy-page";
import {
  isOnboardingWizardActive,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./lib/onboarding-route";

// Route-level code splitting: every page loads its own chunk on first visit
// instead of riding in the entry bundle (PAP entry chunk was 5.7 MB with all
// pages eager). Chunk-load failures after a redeploy
// go through the stale-chunk reload guard in lib/lazy-page.
const Dashboard = lazyPage(() => import("./pages/Dashboard"), "Dashboard");
const DashboardLive = lazyPage(
  () => import("./pages/DashboardLive"),
  "DashboardLive",
);
const Timeline = lazyPage(() => import("./pages/Timeline"), "Timeline");
const Companies = lazyPage(() => import("./pages/Companies"), "Companies");
const Agents = lazyPage(() => import("./pages/Agents"), "Agents");
const AgentDetail = lazyPage(
  () => import("./pages/AgentDetail"),
  "AgentDetail",
);
const Projects = lazyPage(() => import("./pages/Projects"), "Projects");
const ProjectDetail = lazyPage(
  () => import("./pages/ProjectDetail"),
  "ProjectDetail",
);
const Issues = lazyPage(() => import("./pages/Issues"), "Issues");
const Search = lazyPage(() => import("./pages/Search"), "Search");
const IssueDetail = lazyPage(
  () => import("./pages/IssueDetail"),
  "IssueDetail",
);
const IssueChatLongThreadPerf = lazyPage(
  () => import("./pages/IssueChatLongThreadPerf"),
  "IssueChatLongThreadPerf",
);
const Routines = lazyPage(() => import("./pages/Routines"), "Routines");
const Goals = lazyPage(() => import("./pages/Goals"), "Goals");
const RoutineDetail = lazyPage(
  () => import("./pages/RoutineDetail"),
  "RoutineDetail",
);
const UserProfile = lazyPage(
  () => import("./pages/UserProfile"),
  "UserProfile",
);
const Artifacts = lazyPage(() => import("./pages/Artifacts"), "Artifacts");
const GoalDetail = lazyPage(() => import("./pages/GoalDetail"), "GoalDetail");
const Approvals = lazyPage(() => import("./pages/Approvals"), "Approvals");
const ApprovalDetail = lazyPage(
  () => import("./pages/ApprovalDetail"),
  "ApprovalDetail",
);
const Costs = lazyPage(() => import("./pages/Costs"), "Costs");
const Activity = lazyPage(() => import("./pages/Activity"), "Activity");
const Inbox = lazyPage(() => import("./pages/Inbox"), "Inbox");
const WhatNeedsMe = lazyPage(
  () => import("./pages/WhatNeedsMe"),
  "WhatNeedsMe",
);
const CompanySettings = lazyPage(
  () => import("./pages/CompanySettings"),
  "CompanySettings",
);
const CompanySettingsPluginPage = lazyPage(
  () => import("./pages/CompanySettingsPluginPage"),
  "CompanySettingsPluginPage",
);
const CompanyAccess = lazyPage(
  () => import("./pages/CompanyAccess"),
  "CompanyAccess",
);
const CompanyInvites = lazyPage(
  () => import("./pages/CompanyInvites"),
  "CompanyInvites",
);
const CompanySkills = lazyPage(
  () => import("./pages/CompanySkills"),
  "CompanySkills",
);
const SkillStudio = lazyPage(
  () => import("./pages/SkillStudio"),
  "SkillStudio",
);
const Secrets = lazyPage(() => import("./pages/Secrets"), "Secrets");
const CompanyExport = lazyPage(
  () => import("./pages/CompanyExport"),
  "CompanyExport",
);
const CompanyImport = lazyPage(
  () => import("./pages/CompanyImport"),
  "CompanyImport",
);
const DesignGuide = lazyPage(
  () => import("./pages/DesignGuide"),
  "DesignGuide",
);
const InstanceGeneralSettings = lazyPage(
  () => import("./pages/InstanceGeneralSettings"),
  "InstanceGeneralSettings",
);
const InstanceAccess = lazyPage(
  () => import("./pages/InstanceAccess"),
  "InstanceAccess",
);
const ProfileSettings = lazyPage(
  () => import("./pages/ProfileSettings"),
  "ProfileSettings",
);
const PluginManager = lazyPage(
  () => import("./pages/PluginManager"),
  "PluginManager",
);
const PluginSettings = lazyPage(
  () => import("./pages/PluginSettings"),
  "PluginSettings",
);
const AdapterManager = lazyPage(
  () => import("./pages/AdapterManager"),
  "AdapterManager",
);
const PluginPage = lazyPage(() => import("./pages/PluginPage"), "PluginPage");
const OrgChart = lazyPage(() => import("./pages/OrgChart"), "OrgChart");
const NewAgent = lazyPage(() => import("./pages/NewAgent"), "NewAgent");
const AuthPage = lazyPage(() => import("./pages/Auth"), "AuthPage");
const CliAuthPage = lazyPage(() => import("./pages/CliAuth"), "CliAuthPage");
const InviteLandingPage = lazyPage(
  () => import("./pages/InviteLanding"),
  "InviteLandingPage",
);
const JoinRequestQueue = lazyPage(
  () => import("./pages/JoinRequestQueue"),
  "JoinRequestQueue",
);
// Modal overlay rendered unconditionally at the bottom of <App>; lazy so its
// (large) wizard graph stays out of the entry chunk. Suspense fallback is null
// because nothing is visible until the wizard opens.
const OnboardingWizardVariant = lazyPage(
  () => import("./components/OnboardingWizardVariant"),
  "OnboardingWizardVariant",
);

function RouteLoadingFallback() {
  return (
    <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route path="timeline" element={<Timeline />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/members" element={<CompanyAccess />} />
      <Route path="company/settings/invites" element={<CompanyInvites />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="company/settings/secrets" element={<Secrets />} />
      <Route
        path="company/settings/instance"
        element={<Navigate to="general" replace />}
      />
      <Route
        path="company/settings/instance/profile"
        element={<ProfileSettings />}
      />
      <Route
        path="company/settings/instance/general"
        element={<InstanceGeneralSettings />}
      />
      <Route
        path="company/settings/instance/access"
        element={<InstanceAccess />}
      />
      <Route
        path="company/settings/instance/plugins"
        element={<PluginManager />}
      />
      <Route
        path="company/settings/instance/plugins/:pluginId"
        element={<PluginSettings />}
      />
      <Route
        path="company/settings/instance/adapters"
        element={<AdapterManager />}
      />
      <Route
        path="company/settings/:settingsRoutePath/*"
        element={<CompanySettingsPluginPage />}
      />
      <Route path="skills/studio" element={<SkillStudio />} />
      <Route path="skills/studio/new" element={<SkillStudio />} />
      <Route path="skills/studio/:skillId" element={<SkillStudio />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      {AGENT_FILTER_TABS.map((tab) => (
        <Route key={tab} path={`agents/${tab}`} element={<Agents />} />
      ))}
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      {[
        "overview",
        "issues",
        "issues/:filter",
        "configuration",
        "budget",
      ].map((tab) => (
        <Route
          key={tab}
          path={`projects/:projectId/${tab}`}
          element={<ProjectDetail />}
        />
      ))}
      <Route path="issues" element={<Issues />} />
      <Route path="search" element={<Search />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      {import.meta.env.DEV ? (
        <Route
          path="tests/perf/long-thread"
          element={<IssueChatLongThreadPerf />}
        />
      ) : null}
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="artifacts" element={<Artifacts />} />
      <Route
        path="approvals"
        element={<Navigate to="/approvals/pending" replace />}
      />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
      <Route path="decisions" element={<WhatNeedsMe />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      {["mine", "recent", "unread", "blocked", "all"].map((tab) => (
        <Route key={tab} path={`inbox/${tab}`} element={<Inbox />} />
      ))}
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  // The OnboardingWizard auto-opens on this route (and can also be opened
  // explicitly). While it is showing it covers the whole screen, so the
  // launcher card below must not stay interactive behind it — otherwise users
  // can tab/click through to the form behind the modal (PAP-52). The launcher
  // only needs to render as a re-entry point once the wizard is dismissed.
  if (
    isOnboardingWizardActive({
      onboardingOpen,
      routeDismissed: onboardingRouteDismissed,
    })
  ) {
    return null;
  }
  const matchedCompany = companyPrefix
    ? (companies.find(
        (company) =>
          company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
      ) ?? null)
    : null;

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and seed its first agent."
      : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({
                    initialStep: 2,
                    companyId: matchedCompany.id,
                  })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Companyless fallback shared by the unprefixed redirects below. */
function CompanylessRouteFallback({ pathname }: { pathname: string }) {
  if (
    shouldRedirectCompanylessRouteToOnboarding({
      pathname,
      hasCompanies: false,
    })
  ) {
    return <Navigate to="/onboarding" replace />;
  }
  return <NoCompaniesStartPage />;
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) return <RouteLoadingFallback />;

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <CompanylessRouteFallback pathname={location.pathname} />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) return <RouteLoadingFallback />;

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <CompanylessRouteFallback pathname={location.pathname} />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.noCompanies.title", {
            defaultValue: "Create your first company",
          })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompanies.description", {
            defaultValue: "Get started by creating a company.",
          })}
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>
            {t("app.noCompanies.newCompany", { defaultValue: "New Company" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Unprefixed board paths that redirect to their company-prefixed twin via
 * {@link UnprefixedBoardRedirect}. Matching is ranked by path specificity, so
 * the order of this list is irrelevant.
 */
const UNPREFIXED_BOARD_PATHS = [
  "companies",
  "issues",
  "issues/:issueId",
  "routines",
  "routines/:routineId",
  "goals",
  "goals/:goalId",
  "artifacts",
  "decisions",
  "u/:userSlug",
  "skills/studio",
  "skills/studio/new",
  "skills/studio/:skillId",
  "skills/*",
  "agents",
  ...AGENT_FILTER_TABS.map((tab) => `agents/${tab}`),
  "agents/new",
  "agents/:agentId",
  "agents/:agentId/:tab",
  "agents/:agentId/runs/:runId",
  "projects",
  "projects/:projectId",
  "projects/:projectId/overview",
  "projects/:projectId/issues",
  "projects/:projectId/issues/:filter",
  "projects/:projectId/configuration",
];

export function App() {
  return (
    <>
      {/* Covers lazy routes that render OUTSIDE <Layout /> (auth, cli-auth,
          invite, perf harness). Board pages under <Layout /> suspend
          into the closer Suspense boundary around Layout's <Outlet />, so the
          app shell stays mounted while a page chunk loads. */}
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="auth" element={<AuthPage />} />
          <Route path="cli-auth/:id" element={<CliAuthPage />} />
          <Route path="invite/:token" element={<InviteLandingPage />} />
          <Route
            path="tests/perf/long-thread"
            element={<IssueChatLongThreadPerf />}
          />
          <Route element={<AuthenticatedAppGate />}>
            <Route index element={<CompanyRootRedirect />} />
            <Route path="onboarding" element={<OnboardingRoutePage />} />
            {UNPREFIXED_BOARD_PATHS.map((path) => (
              <Route
                key={path}
                path={path}
                element={<UnprefixedBoardRedirect />}
              />
            ))}
            <Route path=":companyPrefix" element={<Layout />}>
              {boardRoutes()}
            </Route>
            <Route path="*" element={<NotFoundPage scope="global" />} />
          </Route>
        </Routes>
      </Suspense>
      {/* Modal overlay; nothing renders until it opens, so no visible fallback. */}
      <Suspense fallback={null}>
        <OnboardingWizardVariant />
      </Suspense>
    </>
  );
}
