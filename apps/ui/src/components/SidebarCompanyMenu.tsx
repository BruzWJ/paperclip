import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, GripVertical, LogOut, Plus, Settings, UserPlus } from "lucide-react";
import { ListGroup, ListItem, ListItems, ListProvider, type DragEndEvent } from "@/components/kibo-ui/list";
import type { Company } from "@paperclipai/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCompanyOrder } from "@/hooks/useCompanyOrder";
import { queryKeys } from "@/lib/queryKeys";
import type { ControlledOpenStateProps } from "@/lib/presentation-contracts";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";

function CompanyAvatar({ company }: { company: Company }) {
  return (
    <Avatar size="sm">
      <AvatarImage src={company.logoUrl ?? undefined} alt={`${company.name} logo`} />
      <AvatarFallback>{company.name.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
    </Avatar>
  );
}

function CompanyMenuItem({
  company,
  isSelected,
  onSelect,
}: {
  company: Company;
  isSelected: boolean;
  onSelect: (company: Company) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(company)}
      className={cn("min-w-0 gap-2 py-2", isSelected && "bg-accent text-accent-foreground")}
    >
      <CompanyAvatar company={company} />
      <span className="min-w-0 flex-1 truncate">{company.name}</span>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
        {company.taskPrefix}
      </span>
      {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
    </DropdownMenuItem>
  );
}

function ReorderableCompanyItem({ company, index }: { company: Company; index: number }) {
  return (
    <ListGroup id={company.id} className="bg-transparent">
      <ListItem
        id={company.id}
        index={index}
        name={`Reorder ${company.name}`}
        parent="companies"
        className="rounded-none border-0 bg-transparent px-2 py-2 shadow-none"
      >
        <CompanyAvatar company={company} />
        <span className="min-w-0 flex-1 truncate">{company.name}</span>
        <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Reorder {company.name}</span>
      </ListItem>
    </ListGroup>
  );
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: ControlledOpenStateProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isEditingOrder, setIsEditingOrder] = useState(false);
  const queryClient = useQueryClient();
  const { companies, selectedCompany } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user.id ?? null;
  const { orderedCompanies, persistOrder } = useCompanyOrder({
    companies: sidebarCompanies,
    userId: currentUserId,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      if (isMobile) setSidebarOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setIsEditingOrder(false);
    setOpen(nextOpen);
  }

  function closeNavigationChrome() {
    setOpen(false);
    setIsEditingOrder(false);
    if (isMobile) setSidebarOpen(false);
  }

  function selectCompany(company: Company) {
    const shouldLeaveCurrentRoute = company.id !== companyId;

    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (shouldLeaveCurrentRoute) {
      void navigate({
        to: "/$companyId/dashboard",
        params: { companyId: company.id },
      });
    }
  }

  function addCompany() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    openOnboarding();
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      if (typeof active.id !== "string" || typeof over.id !== "string") return;

      const ids = orderedCompanies.map((company) => company.id);
      const oldIndex = ids.indexOf(active.id);
      const newIndex = ids.indexOf(over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const nextIds = [...ids];
      const [movedId] = nextIds.splice(oldIndex, 1);
      if (!movedId) return;
      nextIds.splice(newIndex, 0, movedId);
      persistOrder(nextIds);
    },
    [orderedCompanies, persistOrder],
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          // `px-3` (not px-2) so the logo's left edge lines up with the nav icon
          // column (nav px-3 + item px-3) and, crucially, stays put between states:
          // the Button's default size adds `has-[>svg]:px-3`, so with the chevron
          // svg present (expanded) it was already 12px but without it (rail) it fell
          // back to 8px — a 4px horizontal jump on collapse (PAP-10676).
          className="h-9 flex-1 justify-start gap-2 text-left"
          aria-label={
            selectedCompany ? `Open ${selectedCompany.name} company switcher` : "Open company switcher"
          }
        >
          <span className="flex min-w-0 flex-1 items-center">
            {selectedCompany ? (
              <Avatar size="sm">
                <AvatarImage
                  src={selectedCompany.logoUrl ?? undefined}
                  alt={`${selectedCompany.name} logo`}
                />
                <AvatarFallback>{selectedCompany.name.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
              </Avatar>
            ) : null}
            <span
              className={cn("truncate text-sm font-bold text-foreground", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}
            >
              {selectedCompany?.name ?? "Select company"}
            </span>
          </span>
          {!rail && <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64 p-1">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-(length:--text-micro) font-semibold uppercase text-muted-foreground">
            Switch company
          </DropdownMenuLabel>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsEditingOrder((current) => !current);
            }}
          >
            {isEditingOrder ? "Done" : "Edit"}
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {isEditingOrder ? (
            <ListProvider onDragEnd={handleDragEnd}>
              <ListItems className="gap-0 p-0">
                {orderedCompanies.map((company, index) => (
                  <ReorderableCompanyItem key={company.id} company={company} index={index} />
                ))}
              </ListItems>
            </ListProvider>
          ) : (
            orderedCompanies.map((company) => (
              <CompanyMenuItem
                key={company.id}
                company={company}
                isSelected={company.id === companyId}
                onSelect={selectCompany}
              />
            ))
          )}
          {orderedCompanies.length === 0 ? <DropdownMenuItem disabled>No companies</DropdownMenuItem> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={addCompany}
          className="gap-2 py-2 text-muted-foreground"
          disabled={isEditingOrder}
        >
          <Plus className="size-4" />
          <span>Create new company...</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild disabled={isEditingOrder}>
          <Link
            to="/$companyId/company/settings/invites"
            params={{ companyId }}
            onClick={(event) => {
              if (isEditingOrder) {
                event.preventDefault();
                return;
              }
              closeNavigationChrome();
            }}
          >
            <UserPlus className="size-4" />
            <span className="truncate">
              {selectedCompany ? `Invite people to ${selectedCompany.name}` : "Invite people"}
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild disabled={isEditingOrder}>
          <Link
            to="/$companyId/company/settings"
            params={{ companyId }}
            onClick={(event) => {
              if (isEditingOrder) {
                event.preventDefault();
                return;
              }
              closeNavigationChrome();
            }}
          >
            <Settings className="size-4" />
            <span>Company settings</span>
          </Link>
        </DropdownMenuItem>
        {session?.session ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutMutation.mutate()}
              disabled={isEditingOrder || signOutMutation.isPending}
              aria-busy={signOutMutation.isPending}
            >
              <LogOut className="size-4" />
              <span aria-live="polite">{signOutMutation.isPending ? "Signing out..." : "Sign out"}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
