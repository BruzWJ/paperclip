// Empty collections render dedicated UI when data.length === 0.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useDialogActions } from "@/context/DialogContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { companiesApi } from "@/api/companies";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatMoneyAmount, relativeTime } from "@/lib/utils";
import { compareMoneyAmounts, parseMoneyAmount } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  Pencil,
  Check,
  X,
  Plus,
  MoreHorizontal,
  Trash2,
  Users,
  CircleDot,
  DollarSign,
  Calendar,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/$companyId/companies/")({
  component: Companies,
});

const ZERO_AMOUNT = parseMoneyAmount("0");

function Companies() {
  const { companies, loading, error } = useCompany();
  const companyId = useCompanyRouteId();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const { data: stats } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
  });

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const editMutation =   // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  useMutation({
    mutationFn: ({ id, newName }: { id: string; newName: string }) =>
      companiesApi.update(id, { name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companiesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      setConfirmDeleteId(null);
    },
  });
  const companyMutationStatus = editMutation.isPending
    ? "Saving company name…"
    : deleteMutation.isPending
      ? "Deleting company…"
      : null;

  useEffect(() => {
    setBreadcrumbs([{ label: "Companies" }]);
  }, [setBreadcrumbs]);

  function startEdit(companyId: string, currentName: string) {
    setEditingId(companyId);
    setEditName(currentName);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    editMutation.mutate({ id: editingId, newName: editName.trim() });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
  }

  return (
    <div className="space-y-6">
      {companyMutationStatus ? (
        <p className="sr-only" role="status">
          {companyMutationStatus}
        </p>
      ) : null}
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => openOnboarding()}>
          <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1.5" />
          New Company
        </Button>
      </div>

      <div className="h-6">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner /> Loading companies...
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="grid gap-4">
        {companies.map((company) => {
          const selected = company.id === companyId;
          const isEditing = editingId === company.id;
          const isConfirmingDelete = confirmDeleteId === company.id;
          const companyStats = stats?.[company.id];
          const agentCount = companyStats?.agentCount ?? 0;
          const taskCount = companyStats?.taskCount ?? 0;
          const hasBudget = compareMoneyAmounts(company.budgetMonthlyAmount, ZERO_AMOUNT) > 0;

          return (
            <Item
              key={company.id}
              variant="outline"
              className={cn(
                "group relative block p-5 text-left",
                selected && "border-primary ring-1 ring-primary hover:border-primary",
              )}
            >
              <Link
                to="/$companyId/dashboard"
                params={{ companyId: company.id }}
                aria-label={`Open ${company.name} dashboard`}
                className="absolute inset-0 z-0 rounded-md outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50"
              />
              {/* Header row: name + menu */}
              <div className="pointer-events-none relative z-10 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label="Company name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="pointer-events-auto h-7 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="pointer-events-auto"
                        onClick={saveEdit}
                        disabled={editMutation.isPending}
                        aria-label="Save company name"
                      >
                        <Check className="h-3.5 w-3.5"  data-icon="inline-start"/>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="pointer-events-auto"
                        onClick={cancelEdit}
                        aria-label="Cancel company rename"
                      >
                        <X className="h-3.5 w-3.5 text-muted-foreground"  data-icon="inline-start"/>
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-base">{company.name}</h3>
                      <DomainStatus status={company.status} />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="pointer-events-auto text-muted-foreground opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(company.id, company.name);
                        }}
                        aria-label="Rename company"
                      >
                        <Pencil className="h-3 w-3"  data-icon="inline-start"/>
                      </Button>
                    </div>
                  )}
                  {company.description && !isEditing && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{company.description}</p>
                  )}
                </div>

                {/* Three-dot menu */}
                <div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="pointer-events-auto text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label="Company actions"
                      >
                        <MoreHorizontal className="h-4 w-4"  data-icon="inline-start"/>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => startEdit(company.id, company.name)}>
                        <Pencil className="h-3.5 w-3.5"  data-icon="inline-end"/>
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirmDeleteId(company.id)}>
                        <Trash2 className="h-3.5 w-3.5"  data-icon="inline-end"/>
                        Delete Company
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Stats row */}
              <div className="pointer-events-none relative z-10 mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground sm:gap-5">
                <div className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5"  data-icon="inline-start"/>
                  <span>
                    {agentCount} {agentCount === 1 ? "agent" : "agents"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <CircleDot className="h-3.5 w-3.5"  data-icon="inline-start"/>
                  <span>
                    {taskCount} {taskCount === 1 ? "task" : "tasks"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 tabular-nums">
                  <DollarSign className="h-3.5 w-3.5"  data-icon="inline-start"/>
                  <span>
                    {formatMoneyAmount(company.knownSpendAmount, company.budgetCurrency)}
                    {hasBudget ? (
                      <> / {formatMoneyAmount(company.budgetMonthlyAmount, company.budgetCurrency)}</>
                    ) : (
                      <span className="text-xs ml-1">Unlimited budget</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 ml-auto">
                  <Calendar className="h-3.5 w-3.5"  data-icon="inline-start"/>
                  <span>Created {relativeTime(company.createdAt)}</span>
                </div>
              </div>

              <ConfirmActionDialog
                open={isConfirmingDelete}
                onOpenChange={(open) => {
                  if (!open) setConfirmDeleteId(null);
                }}
                title={<>Delete {company.name}?</>}
                description="This deletes the company and all of its data. This action cannot be undone."
                confirmLabel="Delete"
                pendingLabel="Deleting…"
                variant="destructive"
                pending={deleteMutation.isPending}
                onConfirm={() => deleteMutation.mutate(company.id)}
              />
            </Item>
          );
        })}
      </div>
    </div>
  );
}
