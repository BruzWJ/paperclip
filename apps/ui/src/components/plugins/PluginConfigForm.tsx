import { Spinner } from "@/components/ui/spinner";
import { pluginsApi } from "@/api/plugins";
import {
  getDefaultValues,
  JsonSchemaForm,
  validateJsonSchemaForm,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

interface PluginConfigFormProps {
  pluginId: string;
  schema: JsonSchemaNode;
  initialValues?: Record<string, unknown>;
  isLoading?: boolean;
  pluginStatus?: string;
  supportsConfigTest?: boolean;
}

interface ResultMessage {
  type: "success" | "error";
  text: string;
}

export function PluginConfigForm({
  pluginId,
  schema,
  initialValues,
  isLoading,
  pluginStatus,
  supportsConfigTest,
}: PluginConfigFormProps) {
  const queryClient = useQueryClient();

  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  }));

  const hasHydratedRef = useRef(false);
  useEffect(() => {
    hasHydratedRef.current = false;
    setValues(getDefaultValues(schema));
  }, [pluginId, schema]);

  useEffect(() => {
    if (initialValues && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      setValues({
        ...getDefaultValues(schema),
        ...initialValues,
      });
    }
  }, [initialValues, schema]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveMessage, setSaveMessage] = useState<ResultMessage | null>(null);
  const [testResult, setTestResult] = useState<ResultMessage | null>(null);

  const isDirty =
    JSON.stringify(values) !==
    JSON.stringify({
      ...getDefaultValues(schema),
      ...(initialValues ?? {}),
    });

  const saveMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.saveConfig(pluginId, configJson),
    onSuccess: (savedConfig) => {
      hasHydratedRef.current = true;
      setValues({
        ...getDefaultValues(schema),
        ...savedConfig.configJson,
      });
      setSaveMessage({ type: "success", text: "Configuration saved." });
      setTestResult(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.config(pluginId),
      });
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({
        type: "error",
        text: err.message || "Failed to save configuration.",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.testConfig(pluginId, configJson),
    onSuccess: (result) => {
      if (result.valid) {
        setTestResult({ type: "success", text: "Configuration test passed." });
      } else {
        setTestResult({
          type: "error",
          text: result.message || "Configuration test failed.",
        });
      }
    },
    onError: (err: Error) => {
      setTestResult({
        type: "error",
        text: err.message || "Configuration test failed.",
      });
    },
  });

  const handleChange = useCallback((newValues: Record<string, unknown>) => {
    setValues(newValues);
    setErrors({});
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(() => {
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    saveMutation.mutate(values);
  }, [schema, values, saveMutation]);

  const handleTestConnection = useCallback(() => {
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setTestResult(null);
    testMutation.mutate(values);
  }, [schema, values, testMutation]);

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground py-4"
        role="status"
      >
        <Spinner className="h-4 w-4" />
        Loading configuration...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {saveMutation.isPending || testMutation.isPending ? (
        <p className="sr-only" role="status">
          {saveMutation.isPending
            ? "Saving plugin configuration."
            : "Testing plugin configuration."}
        </p>
      ) : null}
      <JsonSchemaForm
        key={pluginId}
        schema={schema}
        values={values}
        onChange={handleChange}
        errors={errors}
        disabled={saveMutation.isPending}
      />

      {[saveMessage, testResult].map((message, index) =>
        message ? (
          <Alert
            key={index}
            role={message.type === "success" ? "status" : "alert"}
            variant={message.type === "error" ? "destructive" : "default"}
          >
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null,
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !isDirty}
          size="sm"
        >
          {saveMutation.isPending ? (
            <>
              <Spinner className="h-3.5 w-3.5" />
              Saving...
            </>
          ) : (
            "Save Configuration"
          )}
        </Button>
        {pluginStatus === "ready" && supportsConfigTest && (
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending}
            size="sm"
          >
            {testMutation.isPending ? (
              <>
                <Spinner className="h-3.5 w-3.5" />
                Testing...
              </>
            ) : (
              "Test Configuration"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
