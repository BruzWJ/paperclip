import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as EmptyUI from "@/components/ui/empty";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Building2, Rocket, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { companiesApi } from "@/api/companies";
import { goalsApi } from "@/api/goals";
import { rememberRootRedirectCompanyId } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { parseOnboardingGoalInput } from "@/lib/onboarding-goal";
import { queryKeys } from "@/lib/queryKeys";

import { ONBOARDING_STORAGE_KEY, Step, loadSavedState } from "./OnboardingWizardState";
import {
  OnboardingCompanyNameStep,
  OnboardingGrowStep,
  OnboardingMissionFields,
  OnboardingMissionPathSelector,
  OnboardingProgress,
} from "./OnboardingWizardSteps";

const ONBOARDING_CHOICES = [
  {
    id: "create",
    icon: Rocket,
    title: "Build a new company",
    description: "Begin with a mission, bring on a lead agent, and grow a team of agents to do the work.",
  },
  {
    id: "grow",
    icon: Zap,
    title: "Add agents to your org",
    description: "Bring AI agents into your existing team or workflows.",
  },
] as const;

export function OnboardingWizard() {
  const {
    onboardingOpen,
    closeOnboarding,
    onboardingRouteDismissed: routeDismissed,
    setOnboardingRouteDismissed: setRouteDismissed,
  } = useDialog();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const onboardingRouteMatch = useMatch({
    from: "/_authenticated/onboarding/",
    shouldThrow: false,
  });
  const isOnboardingRoute = onboardingRouteMatch !== undefined;

  const effectiveOnboardingOpen = onboardingOpen || (isOnboardingRoute && !routeDismissed);

  const saved = useMemo(loadSavedState, []);
  const savedStep = saved?.step;
  const initialStep: Step =
    savedStep === 0 || savedStep === 1 || savedStep === 2 ? savedStep : isOnboardingRoute ? 1 : 0;
  const [step, setStep] = useState<Step>(initialStep);
  const [onboardingPath, setOnboardingPath] = useState<"create" | "grow" | null>(
    (saved?.onboardingPath as "create" | "grow" | null) ?? null,
  );

  const [growWorkflows, setGrowWorkflows] = useState((saved?.growWorkflows as string) ?? "");
  const [growPainPoints, setGrowPainPoints] = useState((saved?.growPainPoints as string) ?? "");
  const [growAutomate, setGrowAutomate] = useState((saved?.growAutomate as string) ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState((saved?.companyName as string) ?? "");
  const [companyGoal, setCompanyGoal] = useState((saved?.companyGoal as string) ?? "");
  const [missionPath, setMissionPath] = useState<"direct" | "questionnaire" | null>(
    (saved?.missionPath as "direct" | "questionnaire" | null) ?? null,
  );
  const [missionConfirmed, setMissionConfirmed] = useState((saved?.missionConfirmed as boolean) ?? false);
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    (saved?.createdCompanyId as string) ?? null,
  );
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    (saved?.createdCompanyGoalId as string) ?? null,
  );

  useEffect(() => {
    setRouteDismissed(false);
    if (isOnboardingRoute) {
      setStep((current) => (current === 0 ? 1 : current));
    }
  }, [isOnboardingRoute, setRouteDismissed]);

  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const state = {
      step,
      companyName,
      companyGoal,
      missionPath,
      missionConfirmed,
      q1,
      q2,
      q3,
      q4,
      createdCompanyId,
      createdCompanyGoalId,
      onboardingPath,
      growWorkflows,
      growPainPoints,
      growAutomate,
    };
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  }, [
    effectiveOnboardingOpen,
    step,
    companyName,
    companyGoal,
    missionPath,
    missionConfirmed,
    q1,
    q2,
    q3,
    q4,
    createdCompanyId,
    createdCompanyGoalId,
    onboardingPath,
    growWorkflows,
    growPainPoints,
    growAutomate,
  ]);

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
    setCreatedCompanyId(null);
    setCreatedCompanyGoalId(null);
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

  // Onboarding owns only company setup. Agent configuration, disposable
  // testing, persistence, and initial-task creation all belong to the native
  // New Agent route.
  async function handleConfirmMission() {
    setLoading(true);
    setError(null);
    try {
      let companyId = createdCompanyId;
      if (!companyId) {
        const company = await companiesApi.create({ name: companyName.trim() });
        companyId = company.id;
        setCreatedCompanyId(companyId);
        rememberRootRedirectCompanyId(companyId);
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      }

      if (!createdCompanyGoalId) {
        const parsedGoal = parseOnboardingGoalInput(companyGoal);
        const goal = await goalsApi.create(companyId, {
          title: parsedGoal.title,
          ...(parsedGoal.description ? { description: parsedGoal.description } : {}),
          level: "company",
          status: "active",
        });
        setCreatedCompanyGoalId(goal.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(companyId),
        });
      }

      rememberRootRedirectCompanyId(companyId);
      await navigate({
        to: "/$companyId/agents/new",
        params: { companyId },
      });
      reset();
      closeOnboarding();
      setRouteDismissed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 0) return; // front door requires click
      if (step === 1 && companyName.trim()) setStep(2);
      else if (step === 2 && companyName.trim() && companyGoal.trim()) void handleConfirmMission();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Set up your company</DialogTitle>
          <DialogDescription>Create a company and define its mission.</DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleClose}
          className="absolute top-4 left-4 z-10 text-muted-foreground/60 hover:text-foreground"
        >
          <X className="h-5 w-5" />
          <span className="sr-only">Close</span>
        </Button>

        {step === 0 && (
          <div className="w-full flex flex-col overflow-y-auto">
            <EmptyUI.Empty className="min-h-(--sz-60vh) border-0">
              <EmptyUI.EmptyHeader>
                <EmptyUI.EmptyTitle>Welcome to Paperclip</EmptyUI.EmptyTitle>
                <EmptyUI.EmptyDescription>How would you like to get started?</EmptyUI.EmptyDescription>
              </EmptyUI.EmptyHeader>
              <EmptyUI.EmptyContent>
                {ONBOARDING_CHOICES.map(({ id, icon: Icon, title, description }) => (
                  <Button
                    key={id}
                    type="button"
                    variant="outline"
                    className="h-auto whitespace-normal"
                    onClick={() => {
                      setOnboardingPath(id);
                      setStep(1);
                    }}
                  >
                    <Icon />
                    <span>
                      <span className="block font-medium">{title}</span>
                      <span className="block text-xs text-muted-foreground">{description}</span>
                    </span>
                  </Button>
                ))}
              </EmptyUI.EmptyContent>
            </EmptyUI.Empty>
          </div>
        )}

        {step !== 0 && (
          <div className="w-full flex flex-col overflow-y-auto transition-(--tp-width) duration-500 ease-in-out md:w-1/2">
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              <OnboardingProgress step={step} onStepChange={setStep} />

              {step === 2 && onboardingPath === "grow" ? (
                <OnboardingGrowStep
                  companyGoal={companyGoal}
                  companyName={companyName}
                  growAutomate={growAutomate}
                  growPainPoints={growPainPoints}
                  growWorkflows={growWorkflows}
                  onBack={() => {
                    setOnboardingPath(null);
                    setStep(0);
                  }}
                  onCompanyGoalChange={setCompanyGoal}
                  onGrowAutomateChange={setGrowAutomate}
                  onGrowPainPointsChange={setGrowPainPoints}
                  onGrowWorkflowsChange={setGrowWorkflows}
                  onWorkDescriptionChange={setQ1}
                  workDescription={q1}
                />
              ) : null}

              {step === 1 ? (
                <OnboardingCompanyNameStep
                  companyName={companyName}
                  onBack={() => {
                    setOnboardingPath(null);
                    setStep(0);
                  }}
                  onCompanyNameChange={setCompanyName}
                  onContinue={() => {
                    if (onboardingPath !== "grow" && !missionPath) {
                      setMissionPath("direct");
                    }
                    setStep(2);
                  }}
                />
              ) : null}

              {step === 2 && onboardingPath !== "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Define your mission</h3>
                      <p className="text-xs text-muted-foreground">
                        Your mission guides the agents you configure and the work{" "}
                        <strong>{companyName}</strong> takes on.
                      </p>
                    </div>
                  </div>

                  <OnboardingMissionPathSelector missionPath={missionPath} onChange={setMissionPath} />

                  <OnboardingMissionFields
                    companyGoal={companyGoal}
                    missionConfirmed={missionConfirmed}
                    missionPath={missionPath}
                    onCompanyGoalChange={setCompanyGoal}
                    onMissionConfirmedChange={setMissionConfirmed}
                    onQuestionChange={(question, value) => {
                      if (question === 1) setQ1(value);
                      else if (question === 2) setQ2(value);
                      else if (question === 3) setQ3(value);
                      else setQ4(value);
                    }}
                    questions={[q1, q2, q3, q4]}
                  />

                  {companyGoal.trim() && (
                    <p className="text-(length:--text-micro) text-muted-foreground italic">
                      You can always change your mission later in settings.
                    </p>
                  )}

                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto justify-start p-0 text-(length:--text-micro) text-muted-foreground"
                    onClick={() => setStep(1)}
                  >
                    ← Change company name
                  </Button>
                </div>
              )}

              {error && (
                <Alert variant="destructive" className="mt-3">
                  <AlertDescription className="text-xs">{error}</AlertDescription>
                </Alert>
              )}

              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => setStep(1)} disabled={loading}>
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
                        <Spinner className="h-3.5 w-3.5 mr-1" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Create company"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="hidden w-1/2 overflow-hidden bg-muted md:block">
          <Skeleton aria-hidden="true" className="size-full rounded-none" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { OnboardingWizard as OnboardingWizardVariant };
export * from "./OnboardingWizardState";
