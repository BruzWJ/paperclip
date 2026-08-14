import { useEffect, useMemo } from "react";
import {
  isValidRoutineDateString,
  syncRoutineVariablesWithTemplate,
  type RoutineVariable,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LabeledFormField } from "@/components/patterns/FormPatterns";

const variableTypes: RoutineVariable["type"][] = ["text", "textarea", "number", "boolean", "select", "date"];

function serializeVariables(value: RoutineVariable[]) {
  return JSON.stringify(value);
}

function parseSelectOptions(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function updateVariableList(
  variables: RoutineVariable[],
  name: string,
  mutate: (variable: RoutineVariable) => RoutineVariable,
) {
  return variables.map((variable) => (variable.name === name ? mutate(variable) : variable));
}

function defaultValueForType(type: RoutineVariable["type"], current: RoutineVariable["defaultValue"]) {
  if (type === "boolean") return null;
  if (type === "date") {
    return typeof current === "string" && isValidRoutineDateString(current) ? current : null;
  }
  return current;
}

export function RoutineVariablesEditor({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: RoutineVariable[];
  onChange: (value: RoutineVariable[]) => void;
}) {
  const syncedVariables = useMemo(
    () => syncRoutineVariablesWithTemplate([title, description], value),
    [description, title, value],
  );
  const syncedSignature = serializeVariables(syncedVariables);
  const currentSignature = serializeVariables(value);

  useEffect(() => {
    if (syncedSignature !== currentSignature) {
      onChange(syncedVariables);
    }
  }, [currentSignature, onChange, syncedSignature, syncedVariables]);

  if (syncedVariables.length === 0) {
    return null;
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <Accordion type="single" defaultValue="variables" collapsible>
        <AccordionItem value="variables" className="border-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline">
            <div>
              <p className="text-sm font-medium">Variables</p>
              <FieldDescription>
                Detected from `{"{{name}}"}` placeholders in the title and instructions.
              </FieldDescription>
            </div>
          </AccordionTrigger>
          <AccordionContent className="pb-0">
            {syncedVariables.map((variable) => (
              <FieldSet key={variable.name} className="gap-3 border-t p-4">
                <FieldLegend className="mb-0">
                  <Badge variant="outline" className="font-mono text-xs">
                    {`{{${variable.name}}}`}
                  </Badge>
                </FieldLegend>
                <FieldDescription>Prompt the user for this value before each manual run.</FieldDescription>

                <FieldGroup className="grid gap-3 md:grid-cols-2">
                  <LabeledFormField label="Label">
                    <Input
                      aria-label={`${variable.label ?? variable.name} label`}
                      value={variable.label ?? ""}
                      onChange={(event) =>
                        onChange(
                          updateVariableList(syncedVariables, variable.name, (current) => ({
                            ...current,
                            label: event.target.value || null,
                          })),
                        )
                      }
                      placeholder={variable.name.replaceAll("_", " ")}
                    />
                  </LabeledFormField>

                  <LabeledFormField label="Type">
                    <Select
                      value={variable.type}
                      onValueChange={(type) =>
                        onChange(
                          updateVariableList(syncedVariables, variable.name, (current) => ({
                            ...current,
                            type: type as RoutineVariable["type"],
                            defaultValue: defaultValueForType(
                              type as RoutineVariable["type"],
                              current.defaultValue,
                            ),
                            options: type === "select" ? current.options : [],
                          })),
                        )
                      }
                    >
                      <SelectTrigger aria-label={`${variable.label ?? variable.name} type`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {variableTypes.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </LabeledFormField>

                  <LabeledFormField
                    className="md:col-span-2"
                    label="Default value"
                    labelActions={
                      <Field orientation="horizontal" className="w-auto">
                        <Checkbox
                          id={`routine-variable-${variable.name}-required`}
                          checked={variable.required}
                          onCheckedChange={(checked) =>
                            onChange(
                              updateVariableList(syncedVariables, variable.name, (current) => ({
                                ...current,
                                required: checked === true,
                              })),
                            )
                          }
                        />
                        <FieldLabel htmlFor={`routine-variable-${variable.name}-required`}>
                          Required
                        </FieldLabel>
                      </Field>
                    }
                  >
                    {variable.type === "textarea" ? (
                      <Textarea
                        aria-label={`${variable.label ?? variable.name} default value`}
                        rows={3}
                        value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                        onChange={(event) =>
                          onChange(
                            updateVariableList(syncedVariables, variable.name, (current) => ({
                              ...current,
                              defaultValue: event.target.value || null,
                            })),
                          )
                        }
                      />
                    ) : variable.type === "boolean" ? (
                      <Select
                        value={
                          variable.defaultValue === true
                            ? "true"
                            : variable.defaultValue === false
                              ? "false"
                              : "__unset__"
                        }
                        onValueChange={(next) =>
                          onChange(
                            updateVariableList(syncedVariables, variable.name, (current) => ({
                              ...current,
                              defaultValue: next === "__unset__" ? null : next === "true",
                            })),
                          )
                        }
                      >
                        <SelectTrigger aria-label={`${variable.label ?? variable.name} default value`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unset__">No default</SelectItem>
                          <SelectItem value="true">True</SelectItem>
                          <SelectItem value="false">False</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : variable.type === "select" ? (
                      <FieldGroup className="grid gap-3 md:grid-cols-2">
                        <LabeledFormField label="Options">
                          <Input
                            aria-label={`${variable.label ?? variable.name} options`}
                            value={variable.options.join(", ")}
                            onChange={(event) => {
                              const options = parseSelectOptions(event.target.value);
                              onChange(
                                updateVariableList(syncedVariables, variable.name, (current) => ({
                                  ...current,
                                  options,
                                  defaultValue:
                                    typeof current.defaultValue === "string" &&
                                    options.includes(current.defaultValue)
                                      ? current.defaultValue
                                      : null,
                                })),
                              );
                            }}
                            placeholder="high, medium, low"
                          />
                        </LabeledFormField>
                        <LabeledFormField label="Default option">
                          <Select
                            value={
                              typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"
                            }
                            onValueChange={(next) =>
                              onChange(
                                updateVariableList(syncedVariables, variable.name, (current) => ({
                                  ...current,
                                  defaultValue: next === "__unset__" ? null : next,
                                })),
                              )
                            }
                          >
                            <SelectTrigger aria-label={`${variable.label ?? variable.name} default option`}>
                              <SelectValue placeholder="No default" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__unset__">No default</SelectItem>
                              {variable.options.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {option}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </LabeledFormField>
                      </FieldGroup>
                    ) : variable.type === "date" ? (
                      <Input
                        type="date"
                        value={typeof variable.defaultValue === "string" ? variable.defaultValue : ""}
                        onChange={(event) =>
                          onChange(
                            updateVariableList(syncedVariables, variable.name, (current) => ({
                              ...current,
                              defaultValue: event.target.value || null,
                            })),
                          )
                        }
                        aria-label={`${variable.label ?? variable.name} default value`}
                      />
                    ) : (
                      <Input
                        aria-label={`${variable.label ?? variable.name} default value`}
                        type={variable.type === "number" ? "number" : "text"}
                        value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                        onChange={(event) =>
                          onChange(
                            updateVariableList(syncedVariables, variable.name, (current) => ({
                              ...current,
                              defaultValue: event.target.value || null,
                            })),
                          )
                        }
                        placeholder={variable.type === "number" ? "42" : "Default value"}
                      />
                    )}
                  </LabeledFormField>
                </FieldGroup>
              </FieldSet>
            ))}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

export { RoutineVariablesHint } from "./RoutineVariablesHint";
