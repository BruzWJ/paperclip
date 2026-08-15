import { createFileRoute } from "@tanstack/react-router";
import { AuthenticatedAppGate } from "@/routes/_authenticated/-AuthenticatedAppGate";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedAppGate,
});
