import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions, useDialogState } from "@/context/DialogContext";

export function RouteLoadingFallback() {
  return (
    <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

export function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();

  if (onboardingOpen || !onboardingRouteDismissed) {
    return null;
  }

  const title =
    companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description =
    companies.length > 0
      ? "Run onboarding again to create another company, then continue in New Agent."
      : "Create your company, then continue in New Agent to configure its first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>Start Onboarding</Button>
        </div>
      </div>
    </div>
  );
}
