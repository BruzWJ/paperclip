import { useMatch, useParams } from "@tanstack/react-router";

/**
 * Returns the canonical company UUID captured by the active board route.
 *
 * Navigation stays owned by TanStack Router; this hook exposes only the
 * domain value needed for typed `params` objects.
 */
export function useCompanyRouteId(): string {
  const { companyId } = useParams({ from: "/_authenticated/$companyId" });
  return companyId;
}

export function useOptionalCompanyRouteId(): string | null {
  const match = useMatch({
    from: "/_authenticated/$companyId",
    shouldThrow: false,
  });
  return match?.params.companyId ?? null;
}
