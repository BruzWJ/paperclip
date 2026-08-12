import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

export function useCurrentUserId(): string | null {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  return session?.user.id ?? null;
}
