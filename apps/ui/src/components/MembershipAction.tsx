import type { MouseEvent } from "react";
import { LogIn, LogOut } from "lucide-react";
import type { ResourceMembershipResourceType, ResourceMembershipState } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ResourceMembershipMutation } from "@/hooks/useResourceMemberships";
import { cn } from "../lib/utils";

interface MembershipActionBaseProps {
  state: ResourceMembershipState;
  resourceName: string;
  pending?: boolean;
  pendingState?: ResourceMembershipState | null;
  compact?: boolean;
}

type MembershipActionProps = MembershipActionBaseProps &
  (
    | {
        mutation: ResourceMembershipMutation;
        resourceId: string;
        resourceType: ResourceMembershipResourceType;
        onJoin?: never;
        onLeave?: never;
      }
    | {
        mutation?: never;
        resourceId?: never;
        resourceType?: never;
        onJoin: () => void;
        onLeave: () => void;
      }
  );

function mutateMembership(props: MembershipActionProps, state: ResourceMembershipState) {
  if (props.mutation) {
    props.mutation.mutate({
      resourceType: props.resourceType,
      resourceId: props.resourceId,
      resourceName: props.resourceName,
      state,
    });
  } else if (state === "joined") {
    props.onJoin();
  } else {
    props.onLeave();
  }
}

/** Shared shadcn membership action, optionally bound directly to the membership mutation. */
export function MembershipAction(props: MembershipActionProps) {
  const { state, resourceName, compact = false } = props;
  const mutationPending = Boolean(
    props.mutation?.isPending &&
    props.mutation.variables?.resourceType === props.resourceType &&
    props.mutation.variables.resourceId === props.resourceId &&
    props.mutation.variables.starred === undefined,
  );
  const pending = props.pending ?? mutationPending;
  const pendingState =
    props.pendingState ?? (mutationPending ? (props.mutation?.variables?.state ?? null) : null);
  const isLeft = state === "left";
  const label = pending ? (pendingState === "left" ? "Leaving..." : "Joining...") : isLeft ? "Join" : "Leave";
  const ariaLabel = `${isLeft ? "Join" : "Leave"} ${resourceName}`;
  const Icon = isLeft ? LogIn : LogOut;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    mutateMembership(props, isLeft ? "joined" : "left");
  }

  return (
    <span
      className={cn(
        "flex w-(--sz-66px) shrink-0 justify-end",
        !isLeft && !compact
          ? "opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          : "opacity-100",
      )}
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={ariaLabel}
        aria-busy={pending ? "true" : undefined}
        disabled={pending}
        onClick={handleClick}
        className="w-(--sz-66px)"
      >
        {pending ? <Spinner className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
        <span>{label}</span>
      </Button>
    </span>
  );
}
