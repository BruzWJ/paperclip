import { createFileRoute } from "@tanstack/react-router";
import { OnboardingRoutePage } from "../../-route-ui";

export const Route = createFileRoute("/_authenticated/onboarding/")({
  component: OnboardingRoutePage,
});
