import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import React, { useState } from "react";
import { JsonSchemaFormContent } from "./JsonSchemaFormContent";
import type { JsonSchemaFormFieldProps } from "./JsonSchemaForm";
import { BooleanField, EnumField, NumberField, StringField } from "./JsonSchemaScalarFields";
import { SecretField } from "./JsonSchemaSecretField";
import { getDefaultForSchema, resolveType, type JsonSchemaNode } from "./JsonSchemaUtils";

/**
 * Specialized field for array values, handling dynamic addition and removal of items.
 */
export const ArrayField = React.memo(
  ({
    propSchema,
    value,
    onChange,
    error,
    disabled,
    label,
    errors,
    path,
  }: {
    propSchema: JsonSchemaNode;
    value: unknown;
    onChange: (val: unknown) => void;
    error?: string;
    disabled: boolean;
    label: string;
    errors: Record<string, string>;
    path: string;
  }) => {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = propSchema.items as JsonSchemaNode;
    const isComplex = resolveType(itemSchema) === "object";

    return (
      <FieldSet>
        <div className="flex items-center justify-between">
          <FieldContent>
            <FieldTitle>{label}</FieldTitle>
            {propSchema.description && <FieldDescription>{propSchema.description}</FieldDescription>}
          </FieldContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              disabled ||
              (propSchema.maxItems !== undefined && items.length >= (propSchema.maxItems as number))
            }
            onClick={() => {
              const newItem = getDefaultForSchema(itemSchema);
              onChange([...items, newItem]);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {isComplex ? "Add item" : "Add"}
          </Button>
        </div>

        <FieldGroup className="gap-3">
          {items.map((item, index) => (
            <Card key={index} className="group relative flex-row items-start gap-2 p-3">
              <div className="flex-1">
                <div className="mb-2 text-xs font-medium text-muted-foreground">Item {index + 1}</div>
                <JsonSchemaField
                  propSchema={itemSchema}
                  value={item}
                  label=""
                  path={`${path}/${index}`}
                  onChange={(newVal) => {
                    const newItems = [...items];
                    newItems[index] = newVal;
                    onChange(newItems);
                  }}
                  disabled={disabled}
                  errors={errors}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                disabled={
                  disabled ||
                  (propSchema.minItems !== undefined && items.length <= (propSchema.minItems as number))
                }
                onClick={() => {
                  const newItems = [...items];
                  newItems.splice(index, 1);
                  onChange(newItems);
                }}
              >
                <Trash2 className="h-4 w-4" />
                <span className="sr-only">Remove item</span>
              </Button>
            </Card>
          ))}
          {items.length === 0 && (
            <Empty className="p-4">
              <EmptyDescription>No items added yet.</EmptyDescription>
            </Empty>
          )}
        </FieldGroup>
        <FieldError>{error}</FieldError>
      </FieldSet>
    );
  },
);

/**
 * Specialized field for object values, handling recursive rendering of nested properties.
 */
export const ObjectField = React.memo(
  ({
    propSchema,
    value,
    onChange,
    disabled,
    label,
    errors,
    path,
  }: {
    propSchema: JsonSchemaNode;
    value: unknown;
    onChange: (val: unknown) => void;
    disabled: boolean;
    label: string;
    errors: Record<string, string>;
    path: string;
  }) => {
    const [isCollapsed, setIsCollapsed] = useState(false);
    const handleObjectChange = (newVal: Record<string, unknown>) => {
      onChange(newVal);
    };

    return (
      <FieldSet>
        <Collapsible open={!isCollapsed} onOpenChange={(open) => setIsCollapsed(!open)}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="h-auto w-full justify-between">
              <FieldContent className="text-left">
                <FieldTitle>{label}</FieldTitle>
                {propSchema.description && <FieldDescription>{propSchema.description}</FieldDescription>}
              </FieldContent>
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <Card className="mt-3 gap-0 py-0">
              <CardContent className="p-4">
                <JsonSchemaFormContent
                  schema={propSchema}
                  values={(value as Record<string, unknown>) ?? {}}
                  onChange={handleObjectChange}
                  disabled={disabled}
                  FieldComponent={JsonSchemaField}
                  errors={Object.fromEntries(
                    Object.entries(errors)
                      .filter(([errPath]) => errPath.startsWith(`${path}/`))
                      .map(([errPath, err]) => [errPath.replace(path, ""), err]),
                  )}
                />
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>
    );
  },
);

/**
 * Orchestrator component that selects and renders the appropriate field type based on the schema node.
 */
export const JsonSchemaField = React.memo(
  ({
    propSchema,
    value,
    onChange,
    error,
    disabled,
    label,
    isRequired,
    errors,
    path,
  }: JsonSchemaFormFieldProps) => {
    const type = resolveType(propSchema);
    const isReadOnly = disabled || propSchema.readOnly === true;

    switch (type) {
      case "boolean":
        return (
          <BooleanField
            id={path}
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
          />
        );

      case "enum":
        return (
          <EnumField
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
            options={propSchema.enum ?? []}
          />
        );

      case "secret-ref":
        return (
          <SecretField
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
            defaultValue={propSchema.default}
            maxLength={typeof propSchema.maxLength === "number" ? propSchema.maxLength : undefined}
          />
        );

      case "number":
      case "integer":
        return (
          <NumberField
            id={path}
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
            defaultValue={propSchema.default}
            type={type as "number" | "integer"}
            minimum={typeof propSchema.minimum === "number" ? propSchema.minimum : undefined}
            maximum={typeof propSchema.maximum === "number" ? propSchema.maximum : undefined}
            suggestions={Array.isArray(propSchema.examples) ? propSchema.examples : undefined}
          />
        );

      case "array":
        return (
          <ArrayField
            propSchema={propSchema}
            value={value}
            onChange={onChange}
            error={error}
            disabled={isReadOnly}
            label={label}
            errors={errors}
            path={path}
          />
        );

      case "object":
        return (
          <ObjectField
            propSchema={propSchema}
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            errors={errors}
            path={path}
          />
        );

      default: // string
        return (
          <StringField
            id={path}
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
            defaultValue={propSchema.default}
            format={propSchema.format}
            maxLength={propSchema.maxLength}
          />
        );
    }
  },
);
