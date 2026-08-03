import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionCompactionSettings } from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { Button } from "@/components/ui/button";
import {
  Field,
  ToggleField,
} from "@/components/agent-config-primitives";

const settingsKey = (companyId: string) =>
  ["companies", companyId, "session-compaction-settings"] as const;

export function SessionCompactionSettingsCard({
  companyId,
}: {
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: settingsKey(companyId),
    queryFn: () => companiesApi.getSessionCompactionSettings(companyId),
  });
  const [draft, setDraft] = useState<SessionCompactionSettings | null>(
    null,
  );

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (settings: SessionCompactionSettings) =>
      companiesApi.updateSessionCompactionSettings(companyId, settings),
    onSuccess: (settings) => {
      setDraft(settings);
      queryClient.setQueryData(settingsKey(companyId), settings);
    },
  });

  const setNumber = (
    key: "reserved" | "tail_turns" | "preserve_recent_tokens",
    value: string,
  ) => {
    if (!draft) return;
    if (value === "") {
      const next = { ...draft };
      delete next[key];
      setDraft(next);
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setDraft({
      ...draft,
      [key]: Math.trunc(parsed),
    });
  };

  const setBoolean = (
    key: "auto" | "prune",
    value: boolean,
    baselineValue: boolean,
  ) => {
    if (!draft) return;
    if (value === baselineValue) {
      const next = { ...draft };
      delete next[key];
      setDraft(next);
      return;
    }
    setDraft({ ...draft, [key]: value });
  };

  if (query.isLoading || !draft) {
    return (
      <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
        {query.isError
          ? "Session compaction settings could not be loaded."
          : "Loading session compaction settings…"}
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data);

  return (
    <div
      className="space-y-4 rounded-md border border-border px-4 py-4"
      data-testid="session-compaction-settings"
    >
      <ToggleField
        label="Automatic compaction"
        hint="Compact an issue execution when the provider context limit is reached."
        checked={draft.auto ?? true}
        onChange={(auto) => setBoolean("auto", auto, true)}
      />
      <ToggleField
        label="Prune old tool output"
        hint="Clear only eligible completed tool output selected by the production compaction flow."
        checked={draft.prune ?? false}
        onChange={(prune) => setBoolean("prune", prune, false)}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Reserved tokens"
          hint="Optional; omitted derives min(20,000, model output capacity)."
        >
          <input
            type="number"
            min={0}
            step={1}
            value={draft.reserved ?? ""}
            placeholder="Derived"
            onChange={(event) => setNumber("reserved", event.target.value)}
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          />
        </Field>
        <Field
          label="Tail turns"
          hint="Optional; omitted keeps Paperclip's default of 2 turns."
        >
          <input
            type="number"
            min={0}
            step={1}
            value={draft.tail_turns ?? ""}
            placeholder="2"
            onChange={(event) => setNumber("tail_turns", event.target.value)}
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          />
        </Field>
        <Field
          label="Recent token budget"
          hint="Optional; omitted derives 25% of usable context (2,000–8,000)."
        >
          <input
            type="number"
            min={0}
            step={1}
            value={draft.preserve_recent_tokens ?? ""}
            placeholder="Derived"
            onChange={(event) =>
              setNumber("preserve_recent_tokens", event.target.value)
            }
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          />
        </Field>
      </div>
      <Field
        label="Compaction model"
        hint="Optional summary/tail model reference. Leave blank to use the productive execution model."
      >
        <input
          type="text"
          value={draft.modelRef ?? ""}
          placeholder="Use execution model"
          onChange={(event) =>
            setDraft(() => {
              const modelRef = event.target.value.trim();
              if (modelRef) return { ...draft, modelRef };
              const next = { ...draft };
              delete next.modelRef;
              return next;
            })
          }
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || mutation.isPending}
          onClick={() => mutation.mutate(draft)}
        >
          {mutation.isPending ? "Saving…" : "Save compaction settings"}
        </Button>
        {mutation.isSuccess && !dirty ? (
          <span className="text-xs text-muted-foreground">Saved</span>
        ) : null}
        {mutation.isError ? (
          <span className="text-xs text-destructive">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Failed to save compaction settings"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
