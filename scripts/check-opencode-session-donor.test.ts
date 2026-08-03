import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertDonorLockStructure,
  assertPaperclipTargetParity,
  computeP1TargetEvidence,
} from "./check-opencode-session-donor.ts";
import {
  experimentalChatMessagesTransform,
  experimentalCompactionAutocontinue,
  experimentalSessionCompacting,
} from "../server/src/services/issue-session-compaction/policy.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LOCK_PATH = path.join(REPO_ROOT, "opencode-donor.lock.json");
const POLICY_PATH =
  "server/src/services/issue-session-compaction/policy.ts";
const ALGORITHMS_PATH =
  "server/src/services/issue-session-compaction/algorithms.ts";

const clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const readLock = async () =>
  JSON.parse(await readFile(LOCK_PATH, "utf8"));

const targetReader = (
  mutations: Readonly<Record<string, string>>,
) =>
  async (relativePath: string) =>
    mutations[relativePath] ??
    readFile(path.join(REPO_ROOT, relativePath), "utf8");

async function mutatedTarget(
  relativePath: string,
  search: string,
  replacement: string,
): Promise<Record<string, string>> {
  const original = await readFile(
    path.join(REPO_ROOT, relativePath),
    "utf8",
  );
  const mutated = original.replace(search, replacement);
  assert.notEqual(
    mutated,
    original,
    `negative fixture must mutate ${relativePath}: ${search}`,
  );
  return { [relativePath]: mutated };
}

test("current exact donor lock and P1 target graph pass", async () => {
  const lock = await readLock();
  assert.doesNotThrow(() => assertDonorLockStructure(lock));
  await assert.doesNotReject(assertPaperclipTargetParity(lock));
  assert.deepEqual(await computeP1TargetEvidence(),
    lock.productionCompaction.p1Target);
});

test("the three fixed P1 bindings have their exact runtime values", () => {
  assert.deepEqual(experimentalSessionCompacting(), {
    context: [],
    prompt: undefined,
  });
  const messages = Object.freeze([
    Object.freeze({ role: "user", text: "byte-exact" }),
    Object.freeze({ role: "assistant", text: "ordered" }),
  ]);
  assert.equal(
    experimentalChatMessagesTransform(messages),
    messages,
    "message transform must preserve the exact array reference",
  );
  assert.deepEqual(experimentalCompactionAutocontinue(), {
    enabled: true,
  });
});

test("lock structure rejects widened or legacy positive evidence", async (t) => {
  const lock = await readLock();

  await t.test("six schema roots are exact", () => {
    const mutated = clone(lock);
    mutated.schema.roots.pop();
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /exact six-root manifest/,
    );
  });

  await t.test("schema exclusions are exact paths", () => {
    const mutated = clone(lock);
    mutated.schema.exclusions.push("packages/schema/src/session*.ts");
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /schema exclusion manifest changed/,
    );
  });

  await t.test("core runner files cannot enter the adoption list", () => {
    const mutated = clone(lock);
    mutated.coreV2.files[0].sourcePath =
      "packages/core/src/session/runner/llm.ts";
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /core file manifest changed/,
    );
  });

  await t.test("provider conversion cannot become adopted", () => {
    const mutated = clone(lock);
    const message = mutated.productionCompaction.files.find(
      (record: { sourcePath: string }) =>
        record.sourcePath ===
        "packages/opencode/src/session/message-v2.ts",
    );
    assert.ok(message);
    const conversion = message.excludedSpans.find(
      (span: { symbol?: string }) =>
        span.symbol === "toModelMessagesEffect",
    );
    assert.ok(conversion);
    message.adoptedSpans.push(conversion);
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /Production compaction adopted\/excluded span manifest changed/,
    );
  });

  await t.test("runner integration evidence cannot return under another key", () => {
    const mutated = clone(lock);
    mutated.productionCompaction.runnerIntegration = {};
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /production compaction lock keys changed/,
    );
  });

  await t.test("Paperclip ownership cannot reintroduce a runner manifest", () => {
    const mutated = clone(lock);
    mutated.paperclipOwnership = { runner: [] };
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /donor lock keys changed/,
    );
  });

  await t.test("the event cut replacement is sealed", () => {
    const mutated = clone(lock);
    mutated.productionCompaction.replacedEventCut.replacement =
      "renamed bridge";
    assert.throws(
      () => assertDonorLockStructure(mutated),
      /Production compaction adopted\/excluded span manifest changed/,
    );
  });
});

test("fixed P1 return shapes reject every context/message/autocontinue mutation", async (t) => {
  const lock = await readLock();
  const cases = [
    {
      name: "nonempty compaction context",
      search: "context: [] as const,",
      replacement: 'context: ["ambient"] as const,',
    },
    {
      name: "replacement compaction prompt",
      search: "prompt: undefined,",
      replacement: 'prompt: "replacement",',
    },
    {
      name: "copied message array",
      search: "): T => messages;",
      replacement: "): T => [...messages] as unknown as T;",
    },
    {
      name: "reordered message array",
      search: "): T => messages;",
      replacement:
        "): T => messages.slice().reverse() as unknown as T;",
    },
    {
      name: "filtered message array",
      search: "): T => messages;",
      replacement:
        "): T => messages.filter(() => true) as unknown as T;",
    },
    {
      name: "disabled auto-continue",
      search: "enabled: true as const,",
      replacement: "enabled: false as const,",
    },
    {
      name: "conditional auto-continue",
      search: "enabled: true as const,",
      replacement:
        "enabled: process.env.PAPERCLIP_AUTO === \"1\" as const,",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const mutations = await mutatedTarget(
        POLICY_PATH,
        fixture.search,
        fixture.replacement,
      );
      await assert.rejects(
        assertPaperclipTargetParity(lock, targetReader(mutations)),
        /must be|return|literal|input array reference|fixed-binding target evidence changed/,
      );
    });
  }
});

test("no registration source can own or replace a P1 binding", async (t) => {
  const lock = await readLock();
  const policy = await readFile(path.join(REPO_ROOT, POLICY_PATH), "utf8");
  const registrations = [
    ["registry", "const compactionPolicyRegistry = new Map();"],
    ["plugin", "const compactionPluginHook = () => undefined;"],
    ["skill", "const compactionSkillHook = () => undefined;"],
    ["adapter", "const compactionAdapterCallback = () => undefined;"],
    ["selected company tool", "const compactionCompanyToolSetter = () => undefined;"],
    ["configuration", "const compactionPolicyConfiguration = {};"],
    ["callback", "const compactionPolicyCallback = () => undefined;"],
    ["dependency injection", "const injectCompactionPolicy = () => undefined;"],
    ["runtime setter", "const setSessionCompacting = () => undefined;"],
  ] as const;

  for (const [name, declaration] of registrations) {
    await t.test(name, async () => {
      const mutated = `${declaration}\n${policy}`;
      await assert.rejects(
        assertPaperclipTargetParity(
          lock,
          targetReader({ [POLICY_PATH]: mutated }),
        ),
        /exactly three declarations|registry|callback|setter|dependency-injection|plugin|skill|adapter|company-tool/,
      );
    });
  }
});

test("algorithms must keep the direct policy import and all three copied call sites", async (t) => {
  const lock = await readLock();
  const cases = [
    {
      name: "alternate policy module",
      search: '} from "./policy.js";',
      replacement: '} from "./alternate-policy.js";',
    },
    {
      name: "compacting call bypass",
      search:
        "const compacting = experimentalSessionCompacting();",
      replacement:
        "const compacting = { context: [] as const, prompt: undefined };",
    },
    {
      name: "message-transform call bypass",
      search:
        "const transformed = experimentalChatMessagesTransform(msgs);",
      replacement: "const transformed = msgs;",
    },
    {
      name: "autocontinue call bypass",
      search: "experimentalCompactionAutocontinue().enabled",
      replacement: "true",
    },
    {
      name: "indirect compacting invocation",
      search:
        "const compacting = experimentalSessionCompacting();",
      replacement:
        "const compacting = experimentalSessionCompacting.call(undefined);",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const mutations = await mutatedTarget(
        ALGORITHMS_PATH,
        fixture.search,
        fixture.replacement,
      );
      await assert.rejects(
        assertPaperclipTargetParity(lock, targetReader(mutations)),
        /bind the P1 policy directly|invoked exactly once|copied donor callsite|fixed-binding target evidence changed/,
      );
    });
  }
});

test("the compaction target graph rejects every retired runner/provider-loop marker", async (t) => {
  const lock = await readLock();
  const algorithms = await readFile(
    path.join(REPO_ROOT, ALGORITHMS_PATH),
    "utf8",
  );
  const forbidden = [
    ["max-step prompt", "MAX_STEPS_PROMPT"],
    ["final-step policy", "finalStepPolicy"],
    ["final-step invocation", "finalStepInvocation"],
    ["final-step regions", "finalStepPolicyRegions"],
    ["deleted max-step substitution", "p1-max-steps-prompt-omitted"],
    ["deleted provider-input substitution", "paperclip-ordered-typed-provider-input"],
    ["runner transition body", "exact-runner-transition-rewrite"],
    ["runner transition owner", "runnerTransition"],
    ["model loop", "model-loop"],
    ["provider conversion effect", "toModelMessagesEffect"],
    ["provider conversion", "toModelMessages"],
    ["Vercel conversion", "convertToModelMessages"],
    ["Vercel model shape", "ModelMessage"],
    ["Vercel UI shape", "UIMessage"],
    ["tool choice", "toolChoice"],
    ["last-step state", "isLastStep"],
    ["final-step state", "finalStep"],
    ["local-tool suppression", "disableLocalTools"],
    ["conditional local-tool catalog", "localToolsEnabled"],
    ["runner source", "session-runner"],
    ["provider-turn source", "provider-turn"],
    ["native-event source", "native-events"],
    ["stateless source", "stateless"],
    ["V1 subtask type", "SubtaskPart"],
    ["V1 subtask handler", "handleSubtask"],
    ["donor compacted event", "Event.Compacted"],
    ["donor compacted schema", "SessionCompactionEvent"],
    ["provider API branch", "api.npm"],
    ["provider metadata lowering", "providerMetadata"],
    ["provider call metadata lowering", "callProviderMetadata"],
    ["V1 Session runtime", "SessionV1"],
    ["V1 compacted stream", "filterCompactedEffect"],
    ["V1 message table", "MessageTable"],
    ["V1 part table", "PartTable"],
  ] as const;

  for (const [name, marker] of forbidden) {
    await t.test(name, async () => {
      const mutated = `${algorithms}\n// negative mutation: ${marker}\n`;
      await assert.rejects(
        assertPaperclipTargetParity(
          lock,
          targetReader({ [ALGORITHMS_PATH]: mutated }),
        ),
        /Compaction target contains forbidden/,
      );
    });
  }

  await t.test("Vercel ai import", async () => {
    const mutated = `import type { ModelMessage } from "ai";\n${algorithms}`;
    await assert.rejects(
      assertPaperclipTargetParity(
        lock,
        targetReader({ [ALGORITHMS_PATH]: mutated }),
      ),
      /forbidden Vercel model message|forbidden Vercel ai import/,
    );
  });
});

test("the target scan stays scoped to the compaction policy graph", async () => {
  const lock = await readLock();
  const unrelatedPath = "server/src/unrelated-experiment.ts";
  await assert.doesNotReject(
    assertPaperclipTargetParity(
      lock,
      targetReader({
        [unrelatedPath]:
          'export const unrelated = { toolChoice: "auto" };',
      }),
    ),
  );
});
