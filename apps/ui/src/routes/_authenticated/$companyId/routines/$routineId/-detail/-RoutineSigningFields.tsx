import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SIGNING_MODES = ["bearer", "hmac_sha256", "github_hmac", "none"];
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["github_hmac", "none"]);
const SIGNING_MODE_DESCRIPTIONS: Record<string, string> = {
  bearer: "Expect a shared bearer token in the Authorization header.",
  hmac_sha256: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
  github_hmac: "Accept X-Paperclip-Signature: sha256=<hex> (HMAC over raw body, no timestamp).",
  none: "No authentication — the webhook URL itself acts as a shared secret.",
};

/** Canonical shadcn fields for routine webhook signing and replay protection. */
export function RoutineSigningFields({
  describeMode = false,
  idPrefix,
  onReplayWindowChange,
  onSigningModeChange,
  replayWindowSec,
  signingMode,
}: {
  describeMode?: boolean;
  idPrefix: string;
  onReplayWindowChange: (value: string) => void;
  onSigningModeChange: (value: string) => void;
  replayWindowSec: string;
  signingMode: string;
}) {
  const signingModeId = `${idPrefix}-signing-mode`;
  return (
    <>
      <LabeledFormField
        label="Signing mode"
        labelFor={signingModeId}
        description={describeMode ? SIGNING_MODE_DESCRIPTIONS[signingMode] : undefined}
      >
        <Select value={signingMode} onValueChange={onSigningModeChange}>
          <SelectTrigger id={signingModeId} aria-label="Signing mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SIGNING_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </LabeledFormField>
      {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(signingMode) ? (
        <LabeledFormField label="Replay window (seconds)" labelFor={`${idPrefix}-replay-window`}>
          <Input
            id={`${idPrefix}-replay-window`}
            aria-label="Replay window (seconds)"
            type="number"
            min="0"
            step="1"
            value={replayWindowSec}
            onChange={(event) => onReplayWindowChange(event.target.value)}
          />
        </LabeledFormField>
      ) : null}
    </>
  );
}
