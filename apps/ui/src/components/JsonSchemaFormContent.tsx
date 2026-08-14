import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import type { JsonSchemaFormFieldProps, JsonSchemaFormProps } from "./JsonSchemaForm";
import { labelFromKey, resolveType, type JsonSchemaNode } from "./JsonSchemaUtils";

interface JsonSchemaFormContentProps extends JsonSchemaFormProps {
  FieldComponent: ComponentType<JsonSchemaFormFieldProps>;
}

/**
 * Schema-driven form layout shared by the public form and recursive object
 * fields. The field renderer is injected so recursive rendering does not
 * create a module cycle between the form shell and its field implementations.
 */
export function JsonSchemaFormContent({
  schema,
  values,
  onChange,
  errors = {},
  disabled,
  className,
  advancedLabel = "Advanced options",
  FieldComponent,
}: JsonSchemaFormContentProps) {
  const type = resolveType(schema);

  const handleRootScalarChange = useCallback(
    (newValue: unknown) => {
      onChange(newValue as Record<string, unknown>);
    },
    [onChange],
  );

  if (type !== "object") {
    return (
      <div className={className}>
        <FieldComponent
          propSchema={schema}
          value={values}
          label=""
          path=""
          onChange={handleRootScalarChange}
          disabled={disabled}
          errors={errors}
        />
      </div>
    );
  }

  const properties = useMemo(() => schema.properties ?? {}, [schema.properties]);
  const requiredFields = useMemo(() => new Set(schema.required ?? []), [schema.required]);

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...values, [key]: value });
    },
    [onChange, values],
  );

  const { essentials, advancedGroups, advancedKeys } = useMemo(() => {
    const essentials: Array<[string, JsonSchemaNode]> = [];
    const groupOrder: string[] = [];
    const groups = new Map<string, Array<[string, JsonSchemaNode]>>();
    const advancedKeys = new Set<string>();
    const defaultGroup = "More options";

    for (const entry of Object.entries(properties)) {
      const [key, propSchema] = entry;
      if (propSchema["x-paperclip-advanced"] === true) {
        advancedKeys.add(key);
        const rawGroup = propSchema["x-paperclip-group"];
        const group = typeof rawGroup === "string" && rawGroup.length > 0 ? rawGroup : defaultGroup;
        if (!groups.has(group)) {
          groups.set(group, []);
          groupOrder.push(group);
        }
        groups.get(group)!.push(entry);
      } else {
        essentials.push(entry);
      }
    }

    return {
      essentials,
      advancedGroups: groupOrder.map((group) => ({
        group,
        fields: groups.get(group)!,
      })),
      advancedKeys,
    };
  }, [properties]);

  const hasAdvanced = advancedGroups.length > 0;
  const hasAdvancedError = useMemo(() => {
    if (!hasAdvanced) return false;
    for (const errorKey of Object.keys(errors)) {
      const stripped = errorKey.startsWith("/") ? errorKey.slice(1) : errorKey;
      const topKey = stripped.split("/")[0];
      if (advancedKeys.has(topKey)) return true;
    }
    return false;
  }, [advancedKeys, errors, hasAdvanced]);

  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  useEffect(() => {
    if (hasAdvancedError) setIsAdvancedOpen(true);
  }, [hasAdvancedError]);

  if (Object.keys(properties).length === 0) {
    return (
      <Empty className={cn("py-4", className)}>
        <EmptyDescription>No configuration options available.</EmptyDescription>
      </Empty>
    );
  }

  const renderField = ([key, propSchema]: [string, JsonSchemaNode]) => {
    const value = values[key];
    const isRequired = requiredFields.has(key);
    const error = errors[`/${key}`];
    const label = labelFromKey(key, propSchema);
    const path = `/${key}`;

    return (
      <FieldComponent
        key={key}
        propSchema={propSchema}
        value={value}
        onChange={(nextValue) => handleFieldChange(key, nextValue)}
        error={error}
        disabled={disabled}
        label={label}
        isRequired={isRequired}
        errors={errors}
        path={path}
      />
    );
  };

  return (
    <div className={cn("space-y-6", className)}>
      <FieldGroup>{essentials.map(renderField)}</FieldGroup>

      {hasAdvanced && (
        <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen} className="rounded-lg border">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="group w-full justify-between">
              {advancedLabel}
              <ChevronRight className="text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-6 p-4 pt-1">
              {advancedGroups.map(({ group, fields }) => (
                <FieldSet key={group}>
                  <FieldLegend>{group}</FieldLegend>
                  <FieldGroup>{fields.map(renderField)}</FieldGroup>
                </FieldSet>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
