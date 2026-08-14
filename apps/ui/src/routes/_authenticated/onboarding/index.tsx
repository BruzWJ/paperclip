import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions, useDialogState } from "@/context/DialogContext";

export const Route = createFileRoute("/_authenticated/onboarding/")({
  component: Onboarding,
});

function Onboarding() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();

  if (onboardingOpen || !onboardingRouteDismissed) return null;

  const hasCompanies = companies.length > 0;
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardHeader>
          <CardTitle>{hasCompanies ? "Create another company" : "Create your first company"}</CardTitle>
          <CardDescription>
            {hasCompanies
              ? "Run onboarding again to create another company, then continue in New Agent."
              : "Create your company, then continue in New Agent to configure its first agent."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => openOnboarding()}>Start Onboarding</Button>
        </CardContent>
      </Card>
    </div>
  );
}
