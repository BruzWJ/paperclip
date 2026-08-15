import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, ShieldCheck } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import {
  Choicebox,
  ChoiceboxIndicator,
  ChoiceboxItem,
  ChoiceboxItemDescription,
  ChoiceboxItemHeader,
  ChoiceboxItemTitle,
} from "@/components/kibo-ui/choicebox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { useCompany } from "@/context/CompanyContext";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/instance/access/")({
  component: InstanceAccess,
});

function InstanceAccess() {
  const companyId = useCompanyRouteId();
  const { companies } = useCompany();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());

  useSettingsBreadcrumbs({
    companyId,
    instance: true,
    page: "Access",
  });

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
  });

  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: !!selectedUserId,
  });

  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(
        userAccessQuery.data.companyAccess
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.companyId),
      ),
    );
  }, [userAccessQuery.data]);

  const updateCompanyAccessMutation =   // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  useMutation({
    mutationFn: () => accessApi.setUserCompanyAccess(selectedUserId!, [...selectedCompanyIds]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.userCompanyAccess(selectedUserId!),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.adminUsers(search),
      });
      toast.success("Company access updated");
    },
  });

  const setAdminMutation = useMutation({
    mutationFn: async (makeAdmin: boolean) => {
      if (!selectedUserId) throw new Error("No user selected");
      if (makeAdmin) return accessApi.promoteInstanceAdmin(selectedUserId);
      return accessApi.demoteInstanceAdmin(selectedUserId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.adminUsers(search),
      });
      if (selectedUserId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.access.userCompanyAccess(selectedUserId),
        });
      }
      toast.success("Instance role updated");
    },
  });

  const pendingAccessStatus = updateCompanyAccessMutation.isPending
    ? "Saving company access…"
    : setAdminMutation.isPending
      ? "Updating instance administrator access…"
      : null;

  if (usersQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading instance users…
      </div>
    );
  }

  if (usersQuery.error) {
    const message =
      usersQuery.error instanceof ApiError && usersQuery.error.status === 403
        ? "Instance admin access is required to manage users."
        : usersQuery.error instanceof Error
          ? usersQuery.error.message
          : "Failed to load users.";
    return (
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      {pendingAccessStatus ? (
        <p className="sr-only" role="status">
          {pendingAccessStatus}
        </p>
      ) : null}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
          <h1 className="text-lg font-semibold">Instance Access</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search users, manage instance-admin status, and control which companies they can access.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-(--gtc-34)">
        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>Select an account to manage its instance access.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <LabeledFormField label="Search users" labelFor="instance-user-search">
              <Input aria-label="instance user search"
                id="instance-user-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or email"
              />
            </LabeledFormField>
            <Choicebox
              value={selectedUserId ?? ""}
              onValueChange={(value) => {
                if (value) setSelectedUserId(value);
              }}
              className="gap-2"
            >
              {(usersQuery.data ?? []).map((user) => (
                <ChoiceboxItem key={user.id} id={`instance-user-${user.id}`} value={user.id}>
                  <ChoiceboxItemHeader className="min-w-0">
                    <ChoiceboxItemTitle className="truncate">
                      {user.name || user.email || user.id}
                      {user.isInstanceAdmin ? <ShieldCheck className="h-4 w-4"  data-icon="inline-start"/> : null}
                    </ChoiceboxItemTitle>
                    <ChoiceboxItemDescription className="truncate">
                      {user.email || user.id}
                    </ChoiceboxItemDescription>
                    <ChoiceboxItemDescription>
                      {user.activeCompanyMembershipCount} active company memberships
                    </ChoiceboxItemDescription>
                  </ChoiceboxItemHeader>
                  <ChoiceboxIndicator id={`instance-user-${user.id}`} />
                </ChoiceboxItem>
              ))}
            </Choicebox>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4">
            {!selectedUserId ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No user selected</EmptyTitle>
                  <EmptyDescription>Select a user to inspect instance access.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : userAccessQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading user access…
              </div>
            ) : userAccessQuery.error ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {userAccessQuery.error instanceof Error
                    ? userAccessQuery.error.message
                    : "Failed to load user access."}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-lg font-semibold">
                      {selectedUser?.name || selectedUser?.email || selectedUserId}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {selectedUser?.email || selectedUserId}
                    </div>
                  </div>
                  <Button
                    variant={selectedUser?.isInstanceAdmin ? "outline" : "default"}
                    onClick={() => setAdminMutation.mutate(!(selectedUser?.isInstanceAdmin ?? false))}
                    disabled={setAdminMutation.isPending}
                  >
                    {selectedUser?.isInstanceAdmin ? "Remove instance admin" : "Promote to instance admin"}
                  </Button>
                </div>

                <div className="space-y-3">
                  <div>
                    <h2 className="text-sm font-semibold">Company access</h2>
                    <p className="text-sm text-muted-foreground">
                      Toggle company membership for this user. New access defaults to an active operator
                      membership.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {companies.map((company) => (
                      <FieldLabel key={company.id}>
                        <Field orientation="horizontal">
                          <Checkbox
                            id={`company-access-${company.id}`}
                            checked={selectedCompanyIds.has(company.id)}
                            onCheckedChange={(checked) => {
                              setSelectedCompanyIds((current) => {
                                const next = new Set(current);
                                if (checked) next.add(company.id);
                                else next.delete(company.id);
                                return next;
                              });
                            }}
                          />
                          <FieldContent>
                            <FieldTitle>{company.name}</FieldTitle>
                            <FieldDescription>{company.taskPrefix}</FieldDescription>
                          </FieldContent>
                        </Field>
                      </FieldLabel>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => updateCompanyAccessMutation.mutate()}
                      disabled={updateCompanyAccessMutation.isPending}
                    >
                      {updateCompanyAccessMutation.isPending ? "Saving…" : "Save company access"}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <h2 className="text-sm font-semibold">Current memberships</h2>
                  <ItemGroup className="gap-2">
                    {(userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                      <Item key={membership.id} variant="outline" size="sm">
                        <ItemContent>
                          <ItemTitle>{membership.companyName || membership.companyId}</ItemTitle>
                          <ItemDescription>
                            {membership.membershipRole} • {membership.status}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions className="text-xs text-muted-foreground">
                          {new Date(membership.updatedAt).toLocaleDateString()}
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
