import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Link,
  type RegisteredRouter,
  type ValidateLinkOptions,
} from "@tanstack/react-router";

interface MetricCardProps<
  TRouter extends RegisteredRouter = RegisteredRouter,
  TOptions = unknown,
> {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  linkOptions?: ValidateLinkOptions<TRouter, TOptions>;
  onClick?: () => void;
}

export function MetricCard<
  TRouter extends RegisteredRouter,
  TOptions,
>(props: MetricCardProps<TRouter, TOptions>): ReactNode;
export function MetricCard({ icon: Icon, value, label, description, linkOptions, onClick }: MetricCardProps) {
  const isClickable = !!(linkOptions || onClick);

  const inner = (
    <div className={`h-full px-4 py-4 sm:px-5 sm:py-5 rounded-lg transition-colors${isClickable ? " hover:bg-accent/50 cursor-pointer" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
            {label}
          </p>
          {description && (
            <div className="text-xs text-muted-foreground/70 mt-1.5 hidden sm:block">{description}</div>
          )}
        </div>
        <Icon className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
      </div>
    </div>
  );

  if (linkOptions) {
    return (
      <Link {...linkOptions} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        className="h-full w-full border-0 bg-transparent p-0 text-left font-inherit text-inherit"
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }

  return inner;
}
