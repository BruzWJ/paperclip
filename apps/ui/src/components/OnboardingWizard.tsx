import { useEffect, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "../lib/utils";
import { getUIAdapter } from "../adapters";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useAdapterCatalogSyncState } from "../adapters/use-adapter-catalog";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { defaultCreateValues } from "./agent-config-defaults";
import { AgentConfigForm } from "./AgentConfigForm";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "../lib/onboarding-launch";
import { buildNewAgentControlPlanePayloads } from "../lib/new-agent-control-plane-payload";
import {
  companySkillPinSchema,
  parseCompanySkillPins,
  type CompanySkillPin,
} from "@paperclipai/shared";
import { useStructuralAdapterConfiguration } from "../adapters/use-structural-adapter-configuration";
import {
  RuntimeAgentConfigurationFields,
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "./RuntimeAgentConfigurationFields";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { FrontDoor } from "./FrontDoor";
import { AgentCapsule } from "./AgentCapsule";
import {
  Building2,
  Bot,
  ListTodo,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Check,
  Loader2,
  X
} from "lucide-react";

type Step = 0 | 1 | 2 | 3 | 4 | 5;

const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace"
];

function buildMissionFromQuestionnaire(q1: string, q2: string, q3: string, q4: string): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim()) parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";
const INCOMPLETE_ONBOARDING_STATE_MESSAGE =
  "Onboarding state is incomplete. Please restart onboarding and try again.";

function loadSavedAdapterConfiguration(
  saved: Record<string, unknown> | null,
): CreateConfigValues {
  const stored =
    saved?.adapterConfigValues
    && typeof saved.adapterConfigValues === "object"
    && !Array.isArray(saved.adapterConfigValues)
      ? saved.adapterConfigValues as Partial<CreateConfigValues>
      : {};
  const values: CreateConfigValues = { ...defaultCreateValues };
  if (typeof stored.adapterType === "string") values.adapterType = stored.adapterType;
  if (typeof stored.cheapModel === "string") values.cheapModel = stored.cheapModel;
  if (typeof stored.cheapModelEnabled === "boolean") {
    values.cheapModelEnabled = stored.cheapModelEnabled;
  }
  if (
    stored.adapterSchemaValues
    && typeof stored.adapterSchemaValues === "object"
    && !Array.isArray(stored.adapterSchemaValues)
  ) {
    values.adapterSchemaValues = { ...stored.adapterSchemaValues };
  }
  if (typeof stored.timeoutSec === "number" && Number.isFinite(stored.timeoutSec)) {
    values.timeoutSec = stored.timeoutSec;
  }
  return values;
}

function loadSavedRuntimeAccess(
  saved: Record<string, unknown> | null,
): RuntimeAgentConfigurationValues {
  const defaults = createEmptyRuntimeAgentConfigurationValues();
  const stored =
    saved?.runtimeAccess &&
    typeof saved.runtimeAccess === "object" &&
    !Array.isArray(saved.runtimeAccess)
      ? (saved.runtimeAccess as Record<string, unknown>)
      : {};
  function loadBooleanMap<Key extends string>(
    fallback: Record<Key, boolean>,
    value: unknown,
  ): Record<Key, boolean> {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      Object.keys(fallback).map((key) => [key, record[key] === true]),
    ) as Record<Key, boolean>;
  }
  return {
    contextGrants: loadBooleanMap(
      defaults.contextGrants,
      stored.contextGrants,
    ),
    actionGrants: loadBooleanMap(
      defaults.actionGrants,
      stored.actionGrants,
    ),
    mentionReachGrants: loadBooleanMap(
      defaults.mentionReachGrants,
      stored.mentionReachGrants,
    ),
  };
}

function loadSavedCompanySkillPins(
  saved: Record<string, unknown> | null,
): CompanySkillPin[] {
  try {
    return parseCompanySkillPins(saved?.companySkillPins ?? []);
  } catch {
    return [];
  }
}

function loadSavedState(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function OnboardingWizard() {
  const {
    onboardingOpen,
    onboardingOptions,
    closeOnboarding,
    onboardingRouteDismissed: routeDismissed,
    setOnboardingRouteDismissed: setRouteDismissed,
  } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  // Support opening the wizard from a route (e.g. /onboarding or an existing
  // company's "add agent" entry point) in addition to the dialog context.
  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  // Fetch the admitted catalog only when the wizard is visible. The wizard is
  // mounted globally, including on /auth, where protected adapter routes are
  // expected to reject signed-out browsers.
  const { adapters: admittedAdapters } = useAdapterCatalogSyncState({
    enabled: effectiveOnboardingOpen,
  });

  const initialStep = effectiveOnboardingOptions.initialStep ?? 0;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  // Restore saved state from localStorage (read once on mount)
  const saved = useMemo(loadSavedState, []);

  const [step, setStep] = useState<Step>((saved?.step as Step) ?? initialStep);
  const [onboardingPath, setOnboardingPath] = useState<"create" | "grow" | null>((saved?.onboardingPath as "create" | "grow" | null) ?? null);

  // "Grow existing" questionnaire fields
  const [growWorkflows, setGrowWorkflows] = useState((saved?.growWorkflows as string) ?? "");
  const [growPainPoints, setGrowPainPoints] = useState((saved?.growPainPoints as string) ?? "");
  const [growAutomate, setGrowAutomate] = useState((saved?.growAutomate as string) ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [companyName, setCompanyName] = useState((saved?.companyName as string) ?? "");
  const [companyGoal, setCompanyGoal] = useState((saved?.companyGoal as string) ?? "");
  const [missionPath, setMissionPath] = useState<"direct" | "questionnaire" | null>((saved?.missionPath as "direct" | "questionnaire" | null) ?? null);
  const [missionConfirmed, setMissionConfirmed] = useState((saved?.missionConfirmed as boolean) ?? false);
  // Questionnaire answers
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  // Step 2
  const [agentName, setAgentName] = useState((saved?.agentName as string) ?? "");
  const [agentTitle, setAgentTitle] = useState(
    (saved?.agentTitle as string) ?? "",
  );
  const [agentCapabilities, setAgentCapabilities] = useState(
    (saved?.agentCapabilities as string) ?? "",
  );
  const [runtimeAccess, setRuntimeAccess] =
    useState<RuntimeAgentConfigurationValues>(
      () => loadSavedRuntimeAccess(saved),
    );
  const [companySkillPins, setCompanySkillPins] = useState<CompanySkillPin[]>(
    () => loadSavedCompanySkillPins(saved),
  );
  const [initialTaskTitle, setInitialTaskTitle] = useState(
    (saved?.initialTaskTitle as string) ?? "",
  );
  const [initialTaskRequest, setInitialTaskRequest] = useState(
    (saved?.initialTaskRequest as string) ?? "",
  );
  const [agentCreateIdempotencyKey, setAgentCreateIdempotencyKey] = useState(
    () =>
      (typeof saved?.agentCreateIdempotencyKey === "string"
        ? saved.agentCreateIdempotencyKey
        : crypto.randomUUID()),
  );
  const [configValues, setConfigValues] = useState<CreateConfigValues>(
    () => loadSavedAdapterConfiguration(saved),
  );
  const adapterType = configValues.adapterType;

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? (saved?.createdCompanyId as string) ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >((saved?.createdCompanyPrefix as string) ?? null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>((saved?.createdAgentId as string) ?? null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    (saved?.createdCompanyGoalId as string) ?? null
  );
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(
    (saved?.createdProjectId as string) ?? null
  );
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(
    (saved?.createdIssueRef as string) ?? null
  );

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(createdCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(createdCompanyId!),
    enabled: Boolean(createdCompanyId),
  });

  // Reset the route-dismissed flag when navigating to a different path.
  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  // Sync step and company when onboarding opens with explicit options.
  // Only override saved state when explicit options provide values.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    // If explicit options are provided, they take precedence over saved state
    if (effectiveOnboardingOptions.initialStep) {
      setStep(effectiveOnboardingOptions.initialStep);
    }
    if (effectiveOnboardingOptions.companyId) {
      setCreatedCompanyId(effectiveOnboardingOptions.companyId);
      setCreatedCompanyPrefix(null);
    }
  }, [
    effectiveOnboardingOpen,
    effectiveOnboardingOptions.companyId,
    effectiveOnboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Persist wizard state to localStorage on every change
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const state = {
      step, companyName, companyGoal, missionPath, missionConfirmed,
      q1, q2, q3, q4, agentName, agentTitle, agentCapabilities,
      runtimeAccess, companySkillPins, initialTaskTitle, initialTaskRequest,
      agentCreateIdempotencyKey, adapterType,
      adapterConfigValues: configValues,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      createdCompanyGoalId, createdProjectId, createdIssueRef,
      onboardingPath, growWorkflows, growPainPoints, growAutomate,
    };
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  }, [
    effectiveOnboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, agentTitle, agentCapabilities,
    runtimeAccess, companySkillPins, initialTaskTitle, initialTaskRequest,
    agentCreateIdempotencyKey, adapterType, configValues,
    createdCompanyId, createdCompanyPrefix, createdAgentId,
    createdCompanyGoalId, createdProjectId, createdIssueRef,
    onboardingPath, growWorkflows, growPainPoints, growAutomate,
  ]);

  const adapterConfigResolution = useMemo(() => {
    try {
      return {
        config: getUIAdapter(adapterType).buildAdapterConfig(configValues),
        error: null,
      };
    } catch (adapterConfigError) {
      return {
        config: {},
        error:
          adapterConfigError instanceof Error
            ? adapterConfigError.message
            : "Adapter configuration could not be built.",
      };
    }
  }, [adapterType, configValues]);
  const adapterConfiguration = useStructuralAdapterConfiguration({
    adapterType,
    adapterConfig: adapterConfigResolution.config,
    enabled:
      effectiveOnboardingOpen
      && step === 4
      && adapterConfigResolution.error === null,
  });

  // The server is the sole catalog supplier. Do not rank or withhold its currently
  // admitted agents in onboarding: surface every selectable candidate.
  const availableAdapters = useMemo(() =>
    listUIAdapters()
      .filter((a) => isVisualAdapterChoice(a.type))
      .map((a) => ({ ...getAdapterDisplay(a.type), label: a.label, type: a.type })),
  [admittedAdapters]);

  function selectAdapterType(nextType: string) {
    const { adapterType: _discard, ...defaults } = defaultCreateValues;
    setConfigValues({
      ...defaults,
      adapterType: nextType,
    });
  }

  function reset() {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    setStep(0);
    setOnboardingPath(null);
    setGrowWorkflows("");
    setGrowPainPoints("");
    setGrowAutomate("");
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setMissionPath(null);
    setMissionConfirmed(false);
    setQ1("");
    setQ2("");
    setQ3("");
    setQ4("");
    setAgentName("");
    setAgentTitle("");
    setAgentCapabilities("");
    setRuntimeAccess(createEmptyRuntimeAgentConfigurationValues());
    setCompanySkillPins([]);
    setInitialTaskTitle("");
    setInitialTaskRequest("");
    setAgentCreateIdempotencyKey(crypto.randomUUID());
    setConfigValues({ ...defaultCreateValues });
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
    // On the /onboarding route the wizard is also kept open by the route
    // itself, so closing the dialog must mark the route dismissed — otherwise
    // effectiveOnboardingOpen stays true and the wizard re-renders instead of
    // handing off to the launcher card (PAP-52).
    setRouteDismissed(true);
  }

  async function handleLaunchToDashboard() {
    if (!createdCompanyId || !createdAgentId) {
      setError(INCOMPLETE_ONBOARDING_STATE_MESSAGE);
      return;
    }
    if (!initialTaskRequest.trim()) {
      setError("Write the first issue request before launching.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const projects = await projectsApi.list(createdCompanyId);
        const existingOnboardingProject = selectReusableOnboardingProject(projects);
        if (existingOnboardingProject) {
          projectId = existingOnboardingProject.id;
        } else {
          const project = await projectsApi.create(
            createdCompanyId,
            buildOnboardingProjectPayload(goalId)
          );
          projectId = project.id;
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.list(createdCompanyId)
          });
        }
        setCreatedProjectId(projectId);
      }

      if (!createdIssueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: initialTaskTitle,
            request: initialTaskRequest,
            ownerAgentId: createdAgentId,
            projectId,
            goalId,
          })
        );
        setCreatedIssueRef(issue.identifier ?? issue.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });
      }

      const prefix = createdCompanyPrefix;
      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(prefix ? `/${prefix}/dashboard` : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch first task");
    } finally {
      setLoading(false);
    }
  }

  // Step 2 → 3 ("Confirm mission"): create the company + its company-level
  // goal, then advance to naming the first agent. Guarded so revisiting the
  // mission step (e.g. via Back) doesn't create a duplicate company.
  async function handleConfirmMission() {
    if (createdCompanyId) {
      setStep(3);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      const parsedGoal = parseOnboardingGoalInput(companyGoal);
      const goal = await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description
          ? { description: parsedGoal.description }
          : {}),
        level: "company",
        status: "active"
      });
      setCreatedCompanyGoalId(goal.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(company.id)
      });

      setStep(3); // → Create your first agent
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  // Step 4 → 5: create the ordinary root agent through the three disjoint
  // board control-plane contracts. No provider work begins until step 5
  // creates the first ordinary issue.
  async function handleCreateAgent() {
    if (!createdCompanyId) return;
    if (createdAgentId) {
      setStep(5);
      return;
    }
    if (!adapterConfiguration.valid) {
      const schemaIssue = adapterConfiguration.fieldErrors
        .map((entry) => entry.message)
        .join(" ");
      setError(
        adapterConfiguration.error
          ?? (schemaIssue
            || "Complete the explicit adapter configuration before creating the agent."),
      );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payloads = buildNewAgentControlPlanePayloads({
        name: agentName.trim(),
        title: agentTitle,
        capabilities: agentCapabilities,
        reportsTo: null,
        runtimeAccess,
        configValues,
        adapterConfig: adapterConfigResolution.config,
        companySkillPins,
      });
      const created = await agentsApi.createRuntimeAgent(
        createdCompanyId,
        payloads.runtimeAgent,
        agentCreateIdempotencyKey,
      );
      await agentsApi.createAdapterConfigRevision(
        created.agent.id,
        payloads.adapterRevision,
        createdCompanyId,
      );
      await agentsApi.updateOperationalConfiguration(
        created.agent.id,
        payloads.operational,
        createdCompanyId,
      );
      setCreatedAgentId(created.agent.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 0) return; // front door requires click
      if (step === 1 && companyName.trim()) setStep(2);
      else if (step === 2 && companyName.trim() && companyGoal.trim()) handleConfirmMission();
      else if (step === 3 && agentName.trim()) setStep(4);
      else if (step === 4 && agentName.trim()) handleCreateAgent();
      else if (step === 5) handleLaunchToDashboard();
    }
  }

  const availableCompanySkills = (companySkills ?? []).filter(
    (skill) => !skill.key.startsWith("paperclipai/paperclip/"),
  );

  function toggleCompanySkill(
    pin: CompanySkillPin,
    checked: boolean,
  ) {
    setCompanySkillPins((current) => {
      const withoutKey = current.filter((entry) => entry.key !== pin.key);
      return parseCompanySkillPins(
        checked ? [...withoutKey, pin] : withoutKey,
      );
    });
  }

  if (!effectiveOnboardingOpen) return null;

  const launchStateIncomplete = step === 5 && (!createdCompanyId || !createdAgentId);
  const visibleError = error ?? (launchStateIncomplete ? INCOMPLETE_ONBOARDING_STATE_MESSAGE : null);

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Step 0: Front Door — full-screen choice */}
          {step === 0 && (
            <div className="w-full flex flex-col overflow-y-auto">
              <FrontDoor onChoose={(path) => {
                setOnboardingPath(path);
                setStep(1);
              }} />
            </div>
          )}

          {/* Left half — form (steps 1+) */}
          {step !== 0 && (
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-(--tp-width) duration-500 ease-in-out",
              step === 1 || step === 2 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* 5-segment progress bar (brand .wsteps/.wstep) — segment N
                  filled once step ≥ N. Completed segments jump back. */}
              <div className="flex items-center gap-1.5 mb-8">
                {([1, 2, 3, 4, 5] as const).map((s) => {
                  const filled = step >= s;
                  const canJump = s < step;
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-label={`Step ${s}`}
                      aria-current={s === step ? "step" : undefined}
                      disabled={!canJump}
                      onClick={() => canJump && setStep(s as Step)}
                      className={cn(
                        "h-1 flex-1 rounded-full transition-colors",
                        filled ? "bg-foreground" : "bg-muted",
                        canJump ? "cursor-pointer" : "cursor-default"
                      )}
                    />
                  );
                })}
              </div>

              {/* Persistent evolving capsule (steps 3–5): a single AgentCapsule
                  held in the same tree slot so React reuses the DOM node and the
                  morph reads as one capsule coming to life — dashed slot →
                  solid (configured) → liquid fill + blue glow (online). */}
              {step >= 3 && step <= 5 && (
                <div className="space-y-4 mb-6">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      {step === 5 ? (
                        <Check className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <Bot className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {step === 3
                          ? "Create your first agent"
                          : step === 4
                            ? "Connect a model"
                            : "Review"}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {step === 3 ? (
                          <>
                            Give this ordinary agent a name. You can configure
                            additional agents and reporting lines later.
                          </>
                        ) : step === 4 ? (
                          <>Choose this agent&apos;s adapter and provider configuration.</>
                        ) : (
                          <>Everything&apos;s set up — your first agent is ready to work.</>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-1.5 py-1 text-center">
                    <AgentCapsule
                      state={step === 3 ? "slot" : step === 4 ? "configured" : "online"}
                      gradient={5}
                      glow="blue"
                      size="md"
                    />
                    <p className="text-(length:--text-micro) text-muted-foreground">
                      {step === 3 ? (
                        "an empty slot for an agent"
                      ) : step === 4 ? (
                        "your first agent, taking shape"
                      ) : (
                        <>
                          <span className="font-medium text-foreground">{agentName}</span>{" "}
                          is online and ready to work!
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {/* Step content */}
              {step === 2 && onboardingPath === "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Sparkles className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Tell us about your team</h3>
                      <p className="text-xs text-muted-foreground">
                        We&apos;ll use this to set up your first agent and plan which agents to add.
                      </p>
                    </div>
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What does your team work on?</label>
                    <input
                      aria-label="What does your team work on?"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. We create educational YouTube content about AI"
                      value={q1}
                      onChange={(e) => setQ1(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What are your current workflows?</label>
                    <textarea
                      aria-label="What are your current workflows?"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Manual content creation, spreadsheet tracking, email outreach"
                      value={growWorkflows}
                      onChange={(e) => setGrowWorkflows(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What pain points would you solve with AI?</label>
                    <textarea
                      aria-label="What pain points would you solve with AI?"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Can't produce content fast enough, no time for social media"
                      value={growPainPoints}
                      onChange={(e) => setGrowPainPoints(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What would you automate first?</label>
                    <input
                      aria-label="What would you automate first?"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Social media scheduling and content repurposing"
                      value={growAutomate}
                      onChange={(e) => setGrowAutomate(e.target.value)}
                    />
                  </div>
                  {companyName.trim() && q1.trim() && (
                    <>
                      {!companyGoal.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const parts = [q1.trim()];
                            if (growPainPoints.trim()) parts.push(`Key challenge: ${growPainPoints.trim()}`);
                            if (growAutomate.trim()) parts.push(`First priority: automate ${growAutomate.trim().toLowerCase()}`);
                            setCompanyGoal(parts.join(". "));
                          }}
                        >
                          Generate mission from answers
                        </Button>
                      )}
                      {companyGoal.trim() && (
                        <div className="group">
                          <label className="text-xs text-foreground mb-1 block">Generated mission — edit however you like:</label>
                          <textarea
                            aria-label="Generated mission"
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                            value={companyGoal}
                            onChange={(e) => setCompanyGoal(e.target.value)}
                          />
                        </div>
                      )}
                    </>
                  )}
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 1: Name your company (both paths) */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Name your company</h3>
                      <p className="text-xs text-muted-foreground">
                        What should we call your company?
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Company name
                    </label>
                    <input
                      aria-label="Company name"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Acme Corp"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && companyName.trim()) {
                          e.preventDefault();
                          if (onboardingPath !== "grow" && !missionPath) setMissionPath("direct");
                          setStep(2);
                        }
                      }}
                      autoFocus
                    />
                  </div>
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 2: Define your mission */}
              {step === 2 && onboardingPath !== "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Define your mission</h3>
                      <p className="text-xs text-muted-foreground">
                        Your mission guides the agents you configure and the work <strong>{companyName}</strong> takes on.
                      </p>
                    </div>
                  </div>

                  {/* Mission path selector */}
                  <div className="space-y-3">
                    <label className="text-xs text-foreground block">
                      How would you like to define your mission?
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "direct"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("direct")}
                      >
                        <Sparkles className="h-4 w-4" />
                        <span className="font-medium">I know my mission</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Type it directly
                        </span>
                      </button>
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "questionnaire"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("questionnaire")}
                      >
                        <ListTodo className="h-4 w-4" />
                        <span className="font-medium">Help me figure it out</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Answer a few questions
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Direct mission input */}
                  {missionPath === "direct" && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyGoal.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Mission
                        </label>
                        <textarea
                          aria-label="Mission"
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                          placeholder="What is your team trying to achieve?"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {/* Prompt chips for inspiration */}
                      <div className="flex flex-wrap gap-1.5">
                        {MISSION_PROMPT_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-(length:--text-micro) transition-colors",
                              companyGoal === chip
                                ? "border-foreground bg-accent text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50"
                            )}
                            onClick={() => setCompanyGoal(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Questionnaire path */}
                  {missionPath === "questionnaire" && !missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What does your team work on?
                        </label>
                        <input
                          aria-label="What does your team work on?"
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. We create educational YouTube content about AI"
                          value={q1}
                          onChange={(e) => setQ1(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Who do you serve?
                        </label>
                        <input
                          aria-label="Who do you serve?"
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Non-technical professionals curious about AI tools"
                          value={q2}
                          onChange={(e) => setQ2(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What's your biggest bottleneck right now?
                        </label>
                        <input
                          aria-label="Biggest bottleneck"
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Can't produce content fast enough across multiple channels"
                          value={q3}
                          onChange={(e) => setQ3(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What would success look like in 6 months?
                        </label>
                        <input
                          aria-label="Six-month success"
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Publishing daily content across 4 platforms with a team of AI agents"
                          value={q4}
                          onChange={(e) => setQ4(e.target.value)}
                        />
                      </div>
                      {q1.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCompanyGoal(buildMissionFromQuestionnaire(q1, q2, q3, q4));
                            setMissionConfirmed(true);
                          }}
                        >
                          Generate my mission
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Questionnaire result — editable mission */}
                  {missionPath === "questionnaire" && missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-foreground mb-1 block">
                          Here's your draft mission — edit it however you like:
                        </label>
                        <textarea
                          aria-label="Draft mission"
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-80px)"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <button
                        className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { setMissionConfirmed(false); setCompanyGoal(""); }}
                      >
                        ← Back to questions
                      </button>
                    </div>
                  )}

                  {/* Confirm mission note */}
                  {companyGoal.trim() && (
                    <p className="text-(length:--text-micro) text-muted-foreground italic">
                      You can always change your mission later in settings.
                    </p>
                  )}

                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setStep(1)}
                  >
                    ← Change company name
                  </button>
                </div>
              )}

              {/* Step 3: Configure the first ordinary root agent. */}
              {step === 3 && (
                <div className="space-y-5">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Name
                    </label>
                    <input
                      aria-label="Agent name"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Agent name"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Title (display only)
                    </label>
                    <input
                      aria-label="Agent title"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Optional title"
                      value={agentTitle}
                      onChange={(event) => setAgentTitle(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Capabilities
                    </label>
                    <textarea
                      aria-label="Agent capabilities"
                      className="min-h-24 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="What work can another agent select this agent to handle?"
                      value={agentCapabilities}
                      onChange={(event) =>
                        setAgentCapabilities(event.target.value)
                      }
                    />
                  </div>
                  <RuntimeAgentConfigurationFields
                    value={runtimeAccess}
                    onChange={setRuntimeAccess}
                    disabled={loading}
                  />
                  <div className="space-y-3 rounded-md border border-border p-3">
                    <div>
                      <h4 className="text-sm font-medium">Company skills</h4>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Select exact immutable skill versions for this agent.
                        Skills provide content only and grant no authority.
                      </p>
                    </div>
                    {availableCompanySkills.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No optional company skills installed yet.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {availableCompanySkills.map((skill) => {
                          const inputId = `onboarding-skill-${skill.id}`;
                          const selectedPin = companySkillPins.find(
                            (pin) => pin.key === skill.key,
                          );
                          const summaryText = resolveSkillSummaryText(skill, {
                            fallbackKey: true,
                          });
                          const parsedPin = companySkillPinSchema.safeParse({
                            key: skill.key,
                            versionId: skill.currentVersionId,
                          });
                          const pin = parsedPin.success
                            ? parsedPin.data
                            : null;
                          return (
                            <div
                              key={skill.id}
                              className="flex items-start gap-3"
                            >
                              <Checkbox
                                id={inputId}
                                checked={Boolean(selectedPin)}
                                disabled={
                                  loading || (pin === null && !selectedPin)
                                }
                                onCheckedChange={(next) => {
                                  if (next === true && pin) {
                                    toggleCompanySkill(pin, true);
                                  } else if (next !== true && selectedPin) {
                                    toggleCompanySkill(selectedPin, false);
                                  }
                                }}
                              />
                              <label
                                htmlFor={inputId}
                                className="grid gap-1 leading-none"
                              >
                                <span className="text-sm font-medium">
                                  {skill.name}
                                </span>
                                {summaryText ? (
                                  <span className="text-xs text-muted-foreground">
                                    {summaryText}
                                  </span>
                                ) : null}
                                {selectedPin ? (
                                  <span className="text-xs text-muted-foreground">
                                    Pinned to {selectedPin.versionId}
                                  </span>
                                ) : pin === null ? (
                                  <span className="text-xs text-destructive">
                                    No immutable version is available.
                                  </span>
                                ) : null}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 4: Connect a local agent and its runtime configuration. */}
              {step === 4 && (
                <div className="space-y-5">
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Local agent
                    </label>
                    {availableAdapters.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No compatible local agent is currently available. Install and
                        authenticate a compatible agent CLI on this host, then retry.
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {availableAdapters.map((opt) => (
                          <button
                            key={opt.type}
                            className={cn(
                              "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                              adapterType === opt.type
                                ? "border-foreground bg-accent"
                                : "border-border hover:bg-accent/50"
                            )}
                            onClick={() => {
                              selectAdapterType(opt.type);
                            }}
                          >
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-(length:--text-nano)">
                              {opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <AgentConfigForm
                    mode="create"
                    values={configValues}
                    onChange={(patch) =>
                      setConfigValues((current) => ({
                        ...current,
                        ...patch,
                      }))
                    }
                    showAdapterTypeField={false}
                    applyAdapterSchemaDefaults={false}
                  />

                  <div className="space-y-3 rounded-md border border-border p-3">
                    {!adapterType ? (
                      <p className="text-xs text-muted-foreground">
                        Select an adapter to begin its explicit configuration.
                      </p>
                    ) : adapterConfigResolution.error ? (
                      <p role="alert" className="text-xs text-destructive">
                        {adapterConfigResolution.error}
                      </p>
                    ) : adapterConfiguration.isLoading ? (
                      <p className="text-xs text-muted-foreground">
                        Loading adapter configuration schema…
                      </p>
                    ) : adapterConfiguration.error || !adapterConfiguration.schema ? (
                      <p role="alert" className="text-xs text-destructive">
                        Adapter configuration schema unavailable.{" "}
                        {adapterConfiguration.error
                          ?? "The adapter did not return a schema."}
                      </p>
                    ) : adapterConfiguration.fieldErrors.length > 0 ? (
                      <p role="alert" className="text-xs text-destructive">
                        Adapter configuration is incomplete:{" "}
                        {adapterConfiguration.fieldErrors
                          .map((entry) => entry.message)
                          .join(" ")}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Draft configuration is structurally valid. Test Agent
                        applies these exact settings through a disposable local runtime
                        session; full workspace readiness is checked after the
                        execution context is persisted.
                      </p>
                    )}

                  </div>
                </div>
              )}

              {/* Step 5: Review — the ordinary agent is configured */}
              {step === 5 && (
                <div className="space-y-5 py-1">
                  {/* Review checklist — everything that's now set up */}
                  <div className="space-y-1.5">
                    {[
                      { label: "Company name", done: Boolean(companyName.trim()) },
                      { label: "Mission", done: Boolean(companyGoal.trim()) },
                      { label: "Agent created", done: Boolean(createdAgentId) },
                      { label: "Runtime access configured", done: Boolean(createdAgentId) },
                      { label: "Adapter revision selected", done: Boolean(createdAgentId) },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center gap-2 text-sm">
                        <span
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-full shrink-0",
                            done
                              ? "bg-green-500/15 text-green-600 dark:text-green-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        <span className={done ? "text-foreground" : "text-muted-foreground"}>
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>

                  {companyGoal.trim() && (
                    <p className="text-sm text-muted-foreground italic text-center">
                      "{companyGoal}"
                    </p>
                  )}
                  <div className="space-y-3 rounded-md border border-border p-3">
                    <div>
                      <h3 className="text-sm font-medium">First issue</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        This board-authored request is the only action that
                        starts the agent's first provider run.
                      </p>
                    </div>
                    <input
                      aria-label="First issue title"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="Issue title (optional)"
                      value={initialTaskTitle}
                      onChange={(event) =>
                        setInitialTaskTitle(event.target.value)
                      }
                    />
                    <textarea
                      aria-label="First issue request"
                      className="min-h-28 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder={`Describe ${agentName || "the agent"}'s first concrete assignment`}
                      value={initialTaskRequest}
                      onChange={(event) =>
                        setInitialTaskRequest(event.target.value)
                      }
                    />
                  </div>
                </div>
              )}

              {/* Error */}
              {visibleError && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{visibleError}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && step > (effectiveOnboardingOptions.initialStep ?? 0) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft data-icon="inline-start" className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim()}
                      onClick={() => {
                        if (onboardingPath !== "grow" && !missionPath) setMissionPath("direct");
                        setStep(2);
                      }}
                    >
                      Next
                      <ArrowRight data-icon="inline-end" className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || !companyGoal.trim() || loading}
                      onClick={handleConfirmMission}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Confirm mission"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!agentName.trim()}
                      onClick={() => setStep(4)}
                    >
                      Next
                      <ArrowRight data-icon="inline-end" className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 4 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() ||
                        loading ||
                        !adapterConfiguration.valid
                      }
                      onClick={handleCreateAgent}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating agent..." : "Create agent"}
                    </Button>
                  )}
                  {step === 5 && (
                    <Button
                      size="sm"
                      onClick={handleLaunchToDashboard}
                      disabled={
                        loading ||
                        launchStateIncomplete ||
                        !initialTaskRequest.trim()
                      }
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Launching..." : "Get started"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
          )}

          {/* Right half — ASCII art (hidden on mobile, only for the team
              name + mission steps) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-(--hex-1d1d1d) transition-(--tp-width-opacity) duration-500 ease-in-out",
              step === 1 || step === 2 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
