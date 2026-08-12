import { useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useDialog } from "../context/DialogContext";
import { rememberRootRedirectCompanyId } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { FrontDoor } from "./FrontDoor";
import {
  Building2,
  ListTodo,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Loader2,
  X,
} from "lucide-react";

type Step = 0 | 1 | 2;

const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace",
];

function buildMissionFromQuestionnaire(
  q1: string,
  q2: string,
  q3: string,
  q4: string,
): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim())
    parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

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

  const effectiveOnboardingOpen =
    onboardingOpen || (isOnboardingRoute && !routeDismissed);

  // Restore saved state from localStorage (read once on mount)
  const saved = useMemo(loadSavedState, []);
  const savedStep = saved?.step;
  const initialStep: Step =
    savedStep === 0 || savedStep === 1 || savedStep === 2
      ? savedStep
      : isOnboardingRoute
        ? 1
        : 0;
  const [step, setStep] = useState<Step>(initialStep);
  const [onboardingPath, setOnboardingPath] = useState<
    "create" | "grow" | null
  >((saved?.onboardingPath as "create" | "grow" | null) ?? null);

  // "Grow existing" questionnaire fields
  const [growWorkflows, setGrowWorkflows] = useState(
    (saved?.growWorkflows as string) ?? "",
  );
  const [growPainPoints, setGrowPainPoints] = useState(
    (saved?.growPainPoints as string) ?? "",
  );
  const [growAutomate, setGrowAutomate] = useState(
    (saved?.growAutomate as string) ?? "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [companyName, setCompanyName] = useState(
    (saved?.companyName as string) ?? "",
  );
  const [companyGoal, setCompanyGoal] = useState(
    (saved?.companyGoal as string) ?? "",
  );
  const [missionPath, setMissionPath] = useState<
    "direct" | "questionnaire" | null
  >((saved?.missionPath as "direct" | "questionnaire" | null) ?? null);
  const [missionConfirmed, setMissionConfirmed] = useState(
    (saved?.missionConfirmed as boolean) ?? false,
  );
  // Questionnaire answers
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    (saved?.createdCompanyId as string) ?? null,
  );
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<
    string | null
  >((saved?.createdCompanyGoalId as string) ?? null);

  // Reset dismissal only when entering or leaving the exact onboarding route.
  useEffect(() => {
    setRouteDismissed(false);
    if (isOnboardingRoute) {
      setStep((current) => (current === 0 ? 1 : current));
    }
  }, [isOnboardingRoute, setRouteDismissed]);

  // Persist wizard state to localStorage on every change
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
          ...(parsedGoal.description
            ? { description: parsedGoal.description }
            : {}),
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
      else if (step === 2 && companyName.trim() && companyGoal.trim())
        void handleConfirmMission();
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
              <FrontDoor
                onChoose={(path) => {
                  setOnboardingPath(path);
                  setStep(1);
                }}
              />
            </div>
          )}

          {/* Left half — form (steps 1+) */}
          {step !== 0 && (
            <div className="w-full flex flex-col overflow-y-auto transition-(--tp-width) duration-500 ease-in-out md:w-1/2">
              <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
                {/* Company setup progress — segment N
                  filled once step ≥ N. Completed segments jump back. */}
                <div className="flex items-center gap-1.5 mb-8">
                  {([1, 2] as const).map((s) => {
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
                          canJump ? "cursor-pointer" : "cursor-default",
                        )}
                      />
                    );
                  })}
                </div>

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
                          We&apos;ll use this to shape the company mission
                          before you configure its first agent.
                        </p>
                      </div>
                    </div>
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
                      />
                    </div>
                    <div className="group">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        What are your current workflows?
                      </label>
                      <textarea
                        aria-label="What are your current workflows?"
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                        placeholder="e.g. Manual content creation, spreadsheet tracking, email outreach"
                        value={growWorkflows}
                        onChange={(e) => setGrowWorkflows(e.target.value)}
                      />
                    </div>
                    <div className="group">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        What pain points would you solve with AI?
                      </label>
                      <textarea
                        aria-label="What pain points would you solve with AI?"
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                        placeholder="e.g. Can't produce content fast enough, no time for social media"
                        value={growPainPoints}
                        onChange={(e) => setGrowPainPoints(e.target.value)}
                      />
                    </div>
                    <div className="group">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        What would you automate first?
                      </label>
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
                              if (growPainPoints.trim())
                                parts.push(
                                  `Key challenge: ${growPainPoints.trim()}`,
                                );
                              if (growAutomate.trim())
                                parts.push(
                                  `First priority: automate ${growAutomate.trim().toLowerCase()}`,
                                );
                              setCompanyGoal(parts.join(". "));
                            }}
                          >
                            Generate mission from answers
                          </Button>
                        )}
                        {companyGoal.trim() && (
                          <div className="group">
                            <label className="text-xs text-foreground mb-1 block">
                              Generated mission — edit however you like:
                            </label>
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
                      onClick={() => {
                        setOnboardingPath(null);
                        setStep(0);
                      }}
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
                            : "text-muted-foreground group-focus-within:text-foreground",
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
                            if (onboardingPath !== "grow" && !missionPath)
                              setMissionPath("direct");
                            setStep(2);
                          }
                        }}
                        autoFocus
                      />
                    </div>
                    <button
                      className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => {
                        setOnboardingPath(null);
                        setStep(0);
                      }}
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
                          Your mission guides the agents you configure and the
                          work <strong>{companyName}</strong> takes on.
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
                              : "border-border hover:bg-accent/50",
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
                              : "border-border hover:bg-accent/50",
                          )}
                          onClick={() => setMissionPath("questionnaire")}
                        >
                          <ListTodo className="h-4 w-4" />
                          <span className="font-medium">
                            Help me figure it out
                          </span>
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
                                : "text-muted-foreground group-focus-within:text-foreground",
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
                                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50",
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
                              setCompanyGoal(
                                buildMissionFromQuestionnaire(q1, q2, q3, q4),
                              );
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
                            Here's your draft mission — edit it however you
                            like:
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
                          onClick={() => {
                            setMissionConfirmed(false);
                            setCompanyGoal("");
                          }}
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

                {/* Error */}
                {error && (
                  <div className="mt-3">
                    <p className="text-xs text-destructive">{error}</p>
                  </div>
                )}

                {/* Footer navigation */}
                <div className="flex items-center justify-between mt-8">
                  <div>
                    {step > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setStep(1)}
                        disabled={loading}
                      >
                        <ArrowLeft
                          data-icon="inline-start"
                          className="h-3.5 w-3.5 mr-1"
                        />
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
                          if (onboardingPath !== "grow" && !missionPath)
                            setMissionPath("direct");
                          setStep(2);
                        }}
                      >
                        Next
                        <ArrowRight
                          data-icon="inline-end"
                          className="h-3.5 w-3.5 ml-1"
                        />
                      </Button>
                    )}
                    {step === 2 && (
                      <Button
                        size="sm"
                        disabled={
                          !companyName.trim() || !companyGoal.trim() || loading
                        }
                        onClick={handleConfirmMission}
                      >
                        {loading ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
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

          {/* Right half — ASCII art for the company setup steps. */}
          <div className="hidden w-1/2 overflow-hidden bg-(--hex-1d1d1d) opacity-100 transition-(--tp-width-opacity) duration-500 ease-in-out md:block">
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
