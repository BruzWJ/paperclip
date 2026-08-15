import type { CompanyMember } from "@/api/access";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
    <FormDialog
      open={!!member}
      onOpenChange={(open) => !open && onClose()}
      contentClassName="max-w-2xl"
      title="Edit member"
      description={`Update company role and membership status for ${memberDisplayName(member)}.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={isSaving || !member}>
            {isSaving ? "Saving…" : "Save member"}
          </Button>
        </>
      }
    >
      {member && (
        <div className="grid gap-4 md:grid-cols-2">
          <LabeledFormField label="Company role" labelFor="member-company-role">
            <Select value={role} onValueChange={onRoleChange}>
              <SelectTrigger id="member-company-role" aria-label="Company role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(USER_COMPANY_MEMBERSHIP_ROLE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabeledFormField>
          <LabeledFormField label="Membership status" labelFor="member-membership-status">
            <Select value={status} onValueChange={onStatusChange}>
              <SelectTrigger id="member-membership-status" aria-label="Membership status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </LabeledFormField>
        </div>
      )}
    </FormDialog>
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
    <ConfirmActionDialog
      open={Boolean(member)}
      onOpenChange={(open) => !open && onClose()}
      title="Remove member?"
      description={<>Archive {memberDisplayName(member)} and revoke their company access.</>}
      confirmLabel="Remove member"
      pendingLabel="Removing..."
      variant="destructive"
      disabled={!member}
      pending={isRemoving}
      onConfirm={onRemove}
    >
      {member ? (
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>{memberDisplayName(member)}</ItemTitle>
            <ItemDescription>{member.user?.email || member.principalId}</ItemDescription>
          </ItemContent>
        </Item>
      ) : null}
    </ConfirmActionDialog>
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
        <Button type="button" variant="outline" onClick={onReject} disabled={disabled}>
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
