import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Building2, ListTodo, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";
import { MISSION_PROMPT_CHIPS, buildMissionFromQuestionnaire, type Step } from "./OnboardingWizardState";

type OnboardingProgressProps = {
  onStepChange: (step: Step) => void;
  step: Step;
};

export function OnboardingProgress({ onStepChange, step }: OnboardingProgressProps) {
  return (
    <div className="mb-8 flex items-center gap-1.5">
      {([1, 2] as const).map((progressStep) => {
        const filled = step >= progressStep;
        const canJump = progressStep < step;
        return (
          <Button
            key={progressStep}
            type="button"
            variant="ghost"
            aria-label={`Step ${progressStep}`}
            aria-current={progressStep === step ? "step" : undefined}
            disabled={!canJump}
            onClick={() => canJump && onStepChange(progressStep)}
            className={cn(
              "h-1 flex-1 rounded-full p-0 transition-colors",
              filled ? "bg-foreground" : "bg-muted",
              canJump ? "cursor-pointer" : "cursor-default",
            )}
          />
        );
      })}
    </div>
  );
}

type OnboardingCompanyNameStepProps = {
  companyName: string;
  onBack: () => void;
  onCompanyNameChange: (value: string) => void;
  onContinue: () => void;
};

export function OnboardingCompanyNameStep({
  companyName,
  onBack,
  onCompanyNameChange,
  onContinue,
}: OnboardingCompanyNameStepProps) {
  return (
    <div className="space-y-5">
      <div className="mb-1 flex items-center gap-3">
        <div className="bg-muted/50 p-2">
          <Building2 className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-medium">Name your company</h3>
          <p className="text-xs text-muted-foreground">What should we call your company?</p>
        </div>
      </div>
      <Field className="group mt-3 gap-1">
        <FieldLabel
          className={cn(
            "text-xs font-normal transition-colors",
            companyName.trim()
              ? "text-foreground"
              : "text-muted-foreground group-focus-within:text-foreground",
          )}
        >
          Company name
        </FieldLabel>
        <Input
          aria-label="Company name"
          placeholder="Acme Corp"
          value={companyName}
          onChange={(event) => onCompanyNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && companyName.trim()) {
              event.preventDefault();
              onContinue();
            }
          }}
          autoFocus
        />
      </Field>
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto justify-start p-0 text-(length:--text-micro) text-muted-foreground"
        onClick={onBack}
      >
        ← Back to start
      </Button>
    </div>
  );
}

type OnboardingGrowStepProps = {
  companyGoal: string;
  companyName: string;
  growAutomate: string;
  growPainPoints: string;
  growWorkflows: string;
  onBack: () => void;
  onCompanyGoalChange: (value: string) => void;
  onGrowAutomateChange: (value: string) => void;
  onGrowPainPointsChange: (value: string) => void;
  onGrowWorkflowsChange: (value: string) => void;
  onWorkDescriptionChange: (value: string) => void;
  workDescription: string;
};

export function OnboardingGrowStep({
  companyGoal,
  companyName,
  growAutomate,
  growPainPoints,
  growWorkflows,
  onBack,
  onCompanyGoalChange,
  onGrowAutomateChange,
  onGrowPainPointsChange,
  onGrowWorkflowsChange,
  onWorkDescriptionChange,
  workDescription,
}: OnboardingGrowStepProps) {
  const generateMission = () => {
    const parts = [workDescription.trim()];
    if (growPainPoints.trim()) {
      parts.push(`Key challenge: ${growPainPoints.trim()}`);
    }
    if (growAutomate.trim()) {
      parts.push(`First priority: automate ${growAutomate.trim().toLowerCase()}`);
    }
    onCompanyGoalChange(parts.join(". "));
  };

  return (
    <div className="space-y-5">
      <div className="mb-1 flex items-center gap-3">
        <div className="bg-muted/50 p-2">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-medium">Tell us about your team</h3>
          <p className="text-xs text-muted-foreground">
            We&apos;ll use this to shape the company mission before you configure its first agent.
          </p>
        </div>
      </div>
      {[
        {
          label: "What does your team work on?",
          placeholder: "e.g. We create educational YouTube content about AI",
          value: workDescription,
          onChange: onWorkDescriptionChange,
          multiline: false,
        },
        {
          label: "What are your current workflows?",
          placeholder: "e.g. Manual content creation, spreadsheet tracking, email outreach",
          value: growWorkflows,
          onChange: onGrowWorkflowsChange,
          multiline: true,
        },
        {
          label: "What pain points would you solve with AI?",
          placeholder: "e.g. Can't produce content fast enough, no time for social media",
          value: growPainPoints,
          onChange: onGrowPainPointsChange,
          multiline: true,
        },
        {
          label: "What would you automate first?",
          placeholder: "e.g. Social media scheduling and content repurposing",
          value: growAutomate,
          onChange: onGrowAutomateChange,
          multiline: false,
        },
      ].map((field) => (
        <Field key={field.label} className="group gap-1">
          <FieldLabel className="text-xs font-normal text-muted-foreground">{field.label}</FieldLabel>
          {field.multiline ? (
            <Textarea
              aria-label={field.label}
              className="min-h-(--sz-60px) resize-none"
              placeholder={field.placeholder}
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
            />
          ) : (
            <Input
              aria-label={field.label}
              placeholder={field.placeholder}
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
            />
          )}
        </Field>
      ))}
      {companyName.trim() && workDescription.trim() ? (
        <>
          {!companyGoal.trim() ? (
            <Button size="sm" variant="outline" onClick={generateMission}>
              Generate mission from answers
            </Button>
          ) : null}
          {companyGoal.trim() ? (
            <Field className="group gap-1">
              <FieldLabel className="text-xs font-normal text-foreground">
                Generated mission — edit however you like:
              </FieldLabel>
              <Textarea
                aria-label="Generated mission"
                className="min-h-(--sz-60px) resize-none"
                value={companyGoal}
                onChange={(event) => onCompanyGoalChange(event.target.value)}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto justify-start p-0 text-(length:--text-micro) text-muted-foreground"
        onClick={onBack}
      >
        ← Back to start
      </Button>
    </div>
  );
}

type OnboardingMissionFieldsProps = {
  companyGoal: string;
  missionConfirmed: boolean;
  missionPath: "direct" | "questionnaire" | null;
  onCompanyGoalChange: (value: string) => void;
  onMissionConfirmedChange: (value: boolean) => void;
  onQuestionChange: (question: 1 | 2 | 3 | 4, value: string) => void;
  questions: readonly [string, string, string, string];
};

export function OnboardingMissionPathSelector({
  missionPath,
  onChange,
}: {
  missionPath: "direct" | "questionnaire" | null;
  onChange: (value: "direct" | "questionnaire") => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground">How would you like to define your mission?</p>
      <ToggleGroup
        type="single"
        value={missionPath ?? ""}
        onValueChange={(value) => {
          if (value === "direct" || value === "questionnaire") onChange(value);
        }}
        className="grid grid-cols-2 gap-2"
      >
        <ToggleGroupItem
          value="direct"
          variant="outline"
          className="h-auto flex-col items-center gap-1.5 p-3 text-xs whitespace-normal"
        >
          <Sparkles className="h-4 w-4" />
          <span className="font-medium">I know my mission</span>
          <span className="text-muted-foreground text-(length:--text-nano)">Type it directly</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="questionnaire"
          variant="outline"
          className="h-auto flex-col items-center gap-1.5 p-3 text-xs whitespace-normal"
        >
          <ListTodo className="h-4 w-4" />
          <span className="font-medium">Help me figure it out</span>
          <span className="text-muted-foreground text-(length:--text-nano)">Answer a few questions</span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function OnboardingMissionFields({
  companyGoal,
  missionConfirmed,
  missionPath,
  onCompanyGoalChange,
  onMissionConfirmedChange,
  onQuestionChange,
  questions,
}: OnboardingMissionFieldsProps) {
  const [q1, q2, q3, q4] = questions;

  if (missionPath === "direct") {
    return (
      <div className="animate-in space-y-3 fade-in duration-200">
        <Field className="group gap-1">
          <FieldLabel
            className={cn(
              "text-xs font-normal",
              companyGoal.trim() ? "text-foreground" : "text-muted-foreground",
            )}
          >
            Mission
          </FieldLabel>
          <Textarea
            aria-label="Mission"
            className="min-h-(--sz-60px) resize-none"
            placeholder="What is your team trying to achieve?"
            value={companyGoal}
            onChange={(event) => onCompanyGoalChange(event.target.value)}
            autoFocus
          />
        </Field>
        <ToggleGroup
          type="single"
          value={companyGoal}
          onValueChange={(value) => value && onCompanyGoalChange(value)}
          className="flex flex-wrap justify-start gap-1.5"
        >
          {MISSION_PROMPT_CHIPS.map((chip) => (
            <ToggleGroupItem
              key={chip}
              value={chip}
              size="sm"
              variant="outline"
              className={cn(
                "h-auto rounded-full px-2.5 py-1 text-(length:--text-micro)",
                companyGoal === chip
                  ? "border-foreground bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
              )}
            >
              {chip}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    );
  }

  if (missionPath !== "questionnaire") return null;

  if (missionConfirmed) {
    return (
      <div className="animate-in space-y-3 fade-in duration-200">
        <Field className="group gap-1">
          <FieldLabel className="text-xs font-normal text-foreground">
            Here&apos;s your draft mission — edit it however you like:
          </FieldLabel>
          <Textarea
            aria-label="Draft mission"
            className="min-h-(--sz-60px) resize-none"
            value={companyGoal}
            onChange={(event) => onCompanyGoalChange(event.target.value)}
            autoFocus
          />
        </Field>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto justify-start p-0 text-(length:--text-micro) text-muted-foreground"
          onClick={() => {
            onMissionConfirmedChange(false);
            onCompanyGoalChange("");
          }}
        >
          ← Back to questions
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-in space-y-3 fade-in duration-200">
      {[
        {
          question: 1 as const,
          label: "What does your team work on?",
          placeholder: "e.g. We create educational YouTube content about AI",
          value: q1,
        },
        {
          question: 2 as const,
          label: "Who do you serve?",
          placeholder: "e.g. Non-technical professionals curious about AI tools",
          value: q2,
        },
        {
          question: 3 as const,
          label: "What's your biggest bottleneck right now?",
          ariaLabel: "Biggest bottleneck",
          placeholder: "e.g. Can't produce content fast enough across multiple channels",
          value: q3,
        },
        {
          question: 4 as const,
          label: "What would success look like in 6 months?",
          ariaLabel: "Six-month success",
          placeholder: "e.g. Publishing daily content across 4 platforms with a team of AI agents",
          value: q4,
        },
      ].map((field) => (
        <Field key={field.question} className="group gap-1">
          <FieldLabel className="text-xs font-normal text-muted-foreground">{field.label}</FieldLabel>
          <Input
            aria-label={field.ariaLabel ?? field.label}
            placeholder={field.placeholder}
            value={field.value}
            onChange={(event) => onQuestionChange(field.question, event.target.value)}
            autoFocus={field.question === 1}
          />
        </Field>
      ))}
      {q1.trim() ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onCompanyGoalChange(buildMissionFromQuestionnaire(q1, q2, q3, q4));
            onMissionConfirmedChange(true);
          }}
        >
          Generate my mission
        </Button>
      ) : null}
    </div>
  );
}
