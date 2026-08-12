import { createFileRoute } from "@tanstack/react-router";
import { AuthenticatedAppGate } from "@/components/AuthenticatedAppGate";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedAppGate,
});
