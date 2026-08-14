import type { CompanyMember } from "@/api/access";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { USER_COMPANY_MEMBERSHIP_ROLE_LABELS } from "@paperclipai/shared";

export type EditableMemberStatus = "pending" | "active" | "suspended";

export function CompanyMemberEditDialog({
  member,
  role,
  status,
  isSaving,
  onRoleChange,
  onStatusChange,
  onClose,
  onSave,
}: {
  member: CompanyMember | null;
  role: CompanyMember["membershipRole"];
  status: EditableMemberStatus;
  isSaving: boolean;
  onRoleChange: (role: CompanyMember["membershipRole"]) => void;
  onStatusChange: (status: EditableMemberStatus) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit member</DialogTitle>
          <DialogDescription>
            Update company role and membership status for{" "}
            {memberDisplayName(member)}.
          </DialogDescription>
        </DialogHeader>
        {member && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel>Company role</FieldLabel>
              <Select value={role} onValueChange={onRoleChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(USER_COMPANY_MEMBERSHIP_ROLE_LABELS).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Membership status</FieldLabel>
              <Select value={status} onValueChange={onStatusChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={isSaving || !member}>
            {isSaving ? "Saving…" : "Save member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CompanyMemberRemovalDialog({
  member,
  isRemoving,
  onClose,
  onRemove,
}: {
  member: CompanyMember | null;
  isRemoving: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  return (
    <AlertDialog
      open={Boolean(member)}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove member?</AlertDialogTitle>
          <AlertDialogDescription>
            Archive {memberDisplayName(member)} and revoke their company access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {member ? (
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>{memberDisplayName(member)}</ItemTitle>
              <ItemDescription>
                {member.user?.email || member.principalId}
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRemoving || !member}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isRemoving || !member}
            onClick={onRemove}
          >
            {isRemoving ? "Removing..." : "Remove member"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PendingJoinRequestCard({
  title,
  subtitle,
  context,
  detail,
  approveLabel,
  rejectLabel,
  disabled,
  onApprove,
  onReject,
}: {
  title: string;
  subtitle: string;
  context: string;
  detail: string;
  approveLabel: string;
  rejectLabel: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{subtitle}</ItemDescription>
        <ItemDescription>{context}</ItemDescription>
        <ItemDescription>{detail}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          type="button"
          variant="outline"
          onClick={onReject}
          disabled={disabled}
        >
          {rejectLabel}
        </Button>
        <Button type="button" onClick={onApprove} disabled={disabled}>
          {approveLabel}
        </Button>
      </ItemActions>
    </Item>
  );
}

function memberDisplayName(member: CompanyMember | null) {
  if (!member) return "this member";
  return member.user?.name?.trim() || member.user?.email || member.principalId;
}
