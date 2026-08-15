import type { LucideIcon } from "lucide-react";
import { ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldTitle } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function TaskPropertiesSection({
  value,
  title,
  description,
  icon: Icon,
  children,
}: {
  value: string;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="py-3 hover:no-underline">
        <span className="flex min-w-0 items-start gap-2.5 text-left">
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-foreground">{title}</span>
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{description}</span>
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-3">{children}</AccordionContent>
    </AccordionItem>
  );
}

export function TaskPropertyRow({
  label,
  children,
  className,
  contentClassName,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Field
      orientation="horizontal"
      data-property-row="true"
      className={cn(
        "min-w-0 flex-col! items-start gap-1.5 py-2 @xs/field-group:flex-row! @xs/field-group:gap-3",
        className,
      )}
    >
      <FieldTitle
        data-property-label={label}
        title={label}
        className="w-full! flex-none! pt-0 text-xs text-muted-foreground @xs/field-group:w-20! @xs/field-group:pt-1.5"
      >
        {label}
      </FieldTitle>
      <FieldContent
        className={cn(
          "w-full! min-w-0 flex-row flex-wrap items-center gap-1.5 @xs/field-group:w-auto!",
          contentClassName,
        )}
      >
        {children}
      </FieldContent>
    </Field>
  );
}

export function TaskPropertyPicker({
  inline = false,
  open,
  onOpenChange,
  ariaLabel,
  trigger,
  trailing,
  children,
  popoverClassName,
  inlinePanelClassName,
}: {
  inline?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel: string;
  trigger: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  popoverClassName?: string;
  inlinePanelClassName?: string;
}) {
  const triggerButton = (
    <Button
      type="button"
      variant="outline"
      size={inline ? "default" : "sm"}
      aria-label={ariaLabel}
      className={cn(
        "h-auto min-w-0 max-w-full flex-1 justify-between overflow-hidden px-2 font-normal shadow-none",
        inline ? "min-h-11" : "min-h-8",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left">{trigger}</span>
      <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"  data-icon="inline-end"/>
    </Button>
  );

  if (inline) {
    return (
      <Collapsible className="contents" open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>{triggerButton}</CollapsibleTrigger>
        {trailing}
        <CollapsibleContent className="basis-full">
          <Card className={cn("mt-2 w-full gap-0 rounded-lg p-2 shadow-none", inlinePanelClassName)}>
            {children}
          </Card>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent className={cn("p-1", popoverClassName)} align="end">
          {children}
        </PopoverContent>
      </Popover>
      {trailing}
    </>
  );
}
