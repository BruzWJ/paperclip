import type { ComponentProps, ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type FieldProps = ComponentProps<typeof Field>;
type SwitchProps = ComponentProps<typeof Switch>;

export interface LabeledFormFieldProps extends Omit<FieldProps, "children"> {
  children: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  errorId?: string;
  label?: ReactNode;
  labelActions?: ReactNode;
  labelClassName?: string;
  labelFor?: string;
  requiredIndicator?: boolean;
}

/**
 * Kibo Patterns `field/layouts/field-layouts-6` vertical field composition.
 *
 * Domain screens keep ownership of values and controls; this wrapper only
 * standardizes the shadcn Field/FieldLabel/FieldDescription structure.
 */
export function LabeledFormField({
  children,
  description,
  error,
  errorId,
  label,
  labelActions,
  labelClassName,
  labelFor,
  requiredIndicator = false,
  ...fieldProps
}: LabeledFormFieldProps) {
  const labelContent = requiredIndicator ? (
    <>
      {label}
      <span aria-hidden="true">*</span>
    </>
  ) : (
    label
  );
  const fieldLabel =
    label === undefined ? null : labelActions !== undefined ? (
      <div className="flex items-center justify-between gap-3">
        <FieldLabel className={labelClassName} htmlFor={labelFor}>
          {labelContent}
        </FieldLabel>
        {labelActions}
      </div>
    ) : (
      <FieldLabel className={labelClassName} htmlFor={labelFor}>
        {labelContent}
      </FieldLabel>
    );
  return (
    <Field {...fieldProps}>
      {fieldLabel}
      {children}
      {description !== undefined ? <FieldDescription>{description}</FieldDescription> : null}
      {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}

export interface SettingsSwitchFieldProps extends Omit<SwitchProps, "id"> {
  description?: ReactNode;
  error?: ReactNode;
  errorId?: string;
  fieldClassName?: string;
  id: string;
  invalid?: boolean;
  label: ReactNode;
}

/** Kibo Patterns `field/layouts/field-layouts-6` horizontal switch field. */
export function SettingsSwitchField({
  description,
  error,
  errorId,
  fieldClassName,
  id,
  invalid,
  label,
  ...switchProps
}: SettingsSwitchFieldProps) {
  return (
    <Field className={fieldClassName} orientation="horizontal" data-invalid={invalid || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description !== undefined ? <FieldDescription>{description}</FieldDescription> : null}
        {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
      </FieldContent>
      <Switch id={id} {...switchProps} />
    </Field>
  );
}

type DialogProps = ComponentProps<typeof Dialog>;
type DialogContentProps = ComponentProps<typeof DialogContent>;

export interface FormDialogProps extends Omit<DialogProps, "children"> {
  children?: ReactNode;
  contentClassName?: string;
  contentProps?: Omit<DialogContentProps, "children" | "className">;
  description?: ReactNode;
  expanded?: boolean;
  footer: ReactNode;
  footerClassName?: string;
  headerActions?: ReactNode;
  headerClassName?: string;
  headerLeading?: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  title: ReactNode;
  titleClassName?: string;
  trigger?: ReactNode;
  triggerAsChild?: boolean;
}

/**
 * Kibo Patterns `dialog/standard/dialog-standard-6` and `-7` form dialog.
 *
 * This is intentionally layout-only: feature code still owns submission,
 * pending state, validation, and close behavior.
 */
export function FormDialog({
  children,
  contentClassName,
  contentProps,
  description,
  expanded = false,
  footer,
  footerClassName,
  headerActions,
  headerClassName,
  headerLeading,
  onExpandedChange,
  title,
  titleClassName,
  trigger,
  triggerAsChild = false,
  ...dialogProps
}: FormDialogProps) {
  const expandable = onExpandedChange !== undefined;
  const expandAction = expandable ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={expanded ? "Restore dialog size" : "Expand dialog"}
      onClick={() => onExpandedChange(!expanded)}
      className="absolute right-12 top-3"
    >
      {expanded ? <Minimize2 /> : <Maximize2 />}
    </Button>
  ) : null;
  return (
    <Dialog {...dialogProps}>
      {trigger !== undefined ? <DialogTrigger asChild={triggerAsChild}>{trigger}</DialogTrigger> : null}
      <DialogContent
        className={cn(
          expandable && "gap-0 p-0",
          expandable && (expanded ? "sm:max-w-2xl" : "sm:max-w-lg"),
          contentClassName,
        )}
        {...contentProps}
      >
        <DialogHeader className={cn(expandable && "border-b p-4 pr-20", headerClassName)}>
          {headerLeading}
          <DialogTitle className={titleClassName}>{title}</DialogTitle>
          {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
          {headerActions ?? expandAction}
        </DialogHeader>
        {children}
        <DialogFooter
          className={cn(expandable && "items-center border-t p-4 sm:justify-between", footerClassName)}
        >
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
