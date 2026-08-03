import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidSelectedCompanySkillSet,
  MATERIALIZED_COMPANY_SKILL_SENTINEL,
  prepareSelectedCompanySkillTargetHome,
  selectedCompanySkillMaterializationKey,
  selectedCompanySkillRuntimeName,
  type ImmutableSelectedCompanySkillVersion,
  type SelectedCompanySkillMaterializationIdentity,
} from "./selected-company-skills.js";

function identity(
  overrides: Partial<SelectedCompanySkillMaterializationIdentity> = {},
): SelectedCompanySkillMaterializationIdentity {
  return {
    companyId: `company-${randomUUID()}`,
    agentId: `agent-${randomUUID()}`,
    executionTargetIdentity: randomBytes(32).toString("hex"),
    adapterConfigRevisionId: `revision-${randomUUID()}`,
    ...overrides,
  };
}

function skill(
  overrides: Partial<ImmutableSelectedCompanySkillVersion> = {},
): ImmutableSelectedCompanySkillVersion {
  return {
    key: "company/example/review",
    runtimeName: "review--0a1b2c3d4e",
    versionId: `version-${randomUUID()}`,
    files: [
      { path: "SKILL.md", kind: "skill", content: "# Review\n" },
      {
        path: "references/guide.md",
        kind: "reference",
        content: "Review guide\n",
      },
    ],
    ...overrides,
  };
}

async function prepare(input: {
  identity: SelectedCompanySkillMaterializationIdentity;
  entries: readonly ImmutableSelectedCompanySkillVersion[];
}) {
  return prepareSelectedCompanySkillTargetHome({
    target: { kind: "local" },
    targetNodeExecutable: process.execPath,
    targetCwd: process.cwd(),
    frontendIdentity: "test-acp@1.0.0",
    identity: input.identity,
    entries: input.entries,
  });
}

async function removeHome(homeDir: string): Promise<void> {
  const makeDirectoriesWritable = async (directory: string): Promise<void> => {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    const entries = await fs.readdir(directory, { withFileTypes: true })
      .catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        makeDirectoriesWritable(path.join(directory, entry.name)),
      ));
  };
  await makeDirectoriesWritable(homeDir);
  await fs.rm(homeDir, { recursive: true, force: true });
}

describe("canonical selected company skill target home", () => {
  it("materializes the exact immutable inventory with a complete sentinel and reuses it", async () => {
    const selectedIdentity = identity();
    const selected = skill();
    const first = await prepare({
      identity: selectedIdentity,
      entries: [selected],
    });
    try {
      expect(first.discoveryRoot).toBe(
        "/run/paperclip-company-skills/selected",
      );
      expect(first.discoveryRoot).not.toContain(first.materializationKey);
      expect(path.basename(first.homeDir)).toBe(first.materializationKey);
      await expect(
        fs.readFile(
          path.join(first.skillsDir, selected.runtimeName, "SKILL.md"),
          "utf8",
        ),
      ).resolves.toBe("# Review\n");
      const sentinel = JSON.parse(
        await fs.readFile(
          path.join(first.homeDir, MATERIALIZED_COMPANY_SKILL_SENTINEL),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(sentinel).toMatchObject({
        version: 1,
        materializationKey: first.materializationKey,
        selectedSetDigest: first.selectedSetDigest,
        sourceFingerprint: first.sourceFingerprint,
        contentDigest: first.contentDigest,
      });
      expect(sentinel.installedInventory).toEqual(
        expect.arrayContaining([
          { path: "skills", type: "directory" },
          {
            path: `skills/${selected.runtimeName}/SKILL.md`,
            type: "file",
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        ]),
      );
      await first.releasePreparationLock();
      await first.verifyAfterReap();

      const second = await prepare({
        identity: selectedIdentity,
        entries: [selected],
      });
      expect(second.materializationKey).toBe(first.materializationKey);
      expect(second.homeDir).toBe(first.homeDir);
      expect(second.reused).toBe(true);
      await second.releasePreparationLock();
      await second.verifyAfterReap();
    } finally {
      await first.releasePreparationLock().catch(() => undefined);
      await removeHome(first.homeDir);
    }
  });

  it("keys homes by company, agent, physical target, revision, and selected set", () => {
    const baseIdentity = identity();
    const selected = skill();
    const base = selectedCompanySkillMaterializationKey({
      identity: baseIdentity,
      entries: [selected],
    });
    const variants = [
      identity({ ...baseIdentity, companyId: "different-company" }),
      identity({ ...baseIdentity, agentId: "different-agent" }),
      identity({
        ...baseIdentity,
        executionTargetIdentity: "b".repeat(64),
      }),
      identity({
        ...baseIdentity,
        adapterConfigRevisionId: "different-revision",
      }),
    ];
    for (const variant of variants) {
      expect(selectedCompanySkillMaterializationKey({
        identity: variant,
        entries: [selected],
      }).materializationKey).not.toBe(base.materializationKey);
    }
    expect(selectedCompanySkillMaterializationKey({
      identity: baseIdentity,
      entries: [skill({ versionId: "different-version" })],
    }).materializationKey).not.toBe(base.materializationKey);
    expect(selectedCompanySkillMaterializationKey({
      identity: baseIdentity,
      entries: [selected],
    }).materializationKey).toBe(base.materializationKey);
  });

  it("collects only the exact complete key under the target lock", async () => {
    const selectedIdentity = identity();
    const selected = skill();
    const prepared = await prepare({
      identity: selectedIdentity,
      entries: [selected],
    });
    await prepared.releasePreparationLock();
    await prepared.verifyAfterReap();

    await expect(
      prepared.collectExact("f".repeat(64)),
    ).rejects.toThrow("crossed its complete key");
    await expect(fs.access(prepared.homeDir)).resolves.toBeUndefined();

    await expect(
      prepared.collectExact(prepared.materializationKey),
    ).resolves.toEqual({
      materializationKey: prepared.materializationKey,
      outcome: "collected",
    });
    await expect(fs.access(prepared.homeDir)).rejects.toThrow();
    const homes = await fs.readdir(path.join(prepared.storeRoot, "homes"));
    expect(homes).not.toContain(prepared.materializationKey);
  });

  it("derives one canonical provider-visible name without execution suffixes", () => {
    expect(
      selectedCompanySkillRuntimeName(
        "paperclipai/paperclip/review",
        "review",
      ),
    ).toBe("review");
    expect(
      selectedCompanySkillRuntimeName("company/example/review", "review"),
    ).toMatch(/^review--[0-9a-f]{10}$/);
    expect(
      selectedCompanySkillRuntimeName(
        "company/example/review",
        "renamed-display-slug",
      ),
    ).toBe(
      selectedCompanySkillRuntimeName("company/example/review", "review"),
    );
    expect(() =>
      selectedCompanySkillRuntimeName("company/example/review", "../review"),
    ).toThrow(InvalidSelectedCompanySkillSet);
  });

  it("quarantines an out-of-band mismatch and rematerializes canonical bytes before launch", async () => {
    const selectedIdentity = identity();
    const selected = skill();
    const first = await prepare({
      identity: selectedIdentity,
      entries: [selected],
    });
    await first.releasePreparationLock();
    const selectedFile = path.join(
      first.skillsDir,
      selected.runtimeName,
      "SKILL.md",
    );
    await fs.chmod(selectedFile, 0o600);
    await fs.writeFile(selectedFile, "mutated\n", "utf8");

    const repaired = await prepare({
      identity: selectedIdentity,
      entries: [selected],
    });
    try {
      expect(repaired.reused).toBe(false);
      await expect(fs.readFile(selectedFile, "utf8")).resolves.toBe(
        "# Review\n",
      );
      const quarantineEntries = await fs.readdir(
        path.join(repaired.storeRoot, "quarantine"),
      );
      expect(
        quarantineEntries.some((entry) =>
          entry.startsWith(first.materializationKey),
        ),
      ).toBe(true);
      await repaired.releasePreparationLock();
      await repaired.verifyAfterReap();
    } finally {
      await repaired.releasePreparationLock().catch(() => undefined);
      await removeHome(repaired.homeDir);
    }
  });

  it("quarantines a post-reap write and permanently fails that target/frontend conformance", async () => {
    const selectedIdentity = identity();
    const selected = skill();
    const prepared = await prepare({
      identity: selectedIdentity,
      entries: [selected],
    });
    await prepared.releasePreparationLock();
    const selectedFile = path.join(
      prepared.skillsDir,
      selected.runtimeName,
      "SKILL.md",
    );
    await fs.chmod(selectedFile, 0o600);
    await fs.writeFile(selectedFile, "write violation\n", "utf8");

    await expect(prepared.verifyAfterReap()).rejects.toBeInstanceOf(
      InvalidSelectedCompanySkillSet,
    );
    await expect(
      prepare({ identity: selectedIdentity, entries: [selected] }),
    ).rejects.toBeInstanceOf(InvalidSelectedCompanySkillSet);
    await expect(fs.access(prepared.homeDir)).rejects.toThrow();
  });

  it("fails closed for traversal, file/directory collisions, duplicate names, and missing SKILL.md", () => {
    const selectedIdentity = identity();
    const base = skill();
    const invalidSets: readonly ImmutableSelectedCompanySkillVersion[][] = [
      [skill({ files: [{ path: "../escape", kind: "other", content: "x" }] })],
      [skill({ files: [
        { path: "SKILL.md", kind: "skill", content: "x" },
        { path: "SKILL.md/child", kind: "other", content: "x" },
      ] })],
      [skill({ files: [{ path: "guide.md", kind: "markdown", content: "x" }] })],
      [base, skill({ key: "different-key", runtimeName: base.runtimeName })],
      [skill({
        files: [
          {
            path: "SKILL.md",
            kind: "unknown" as "other",
            content: "x",
          },
        ],
      })],
    ];
    for (const entries of invalidSets) {
      expect(() => selectedCompanySkillMaterializationKey({
        identity: selectedIdentity,
        entries,
      })).toThrow(InvalidSelectedCompanySkillSet);
    }
  });

  it("holds the interprocess lock through preparation and converges concurrent callers", async () => {
    const selectedIdentity = identity();
    const selected = skill();
    const firstPromise = prepare({
      identity: selectedIdentity,
      entries: [selected],
    }).then((home) => ({ caller: "first" as const, home }));
    const secondPromise = prepare({
      identity: selectedIdentity,
      entries: [selected],
    }).then((home) => ({ caller: "second" as const, home }));
    const winner = await Promise.race([firstPromise, secondPromise]);
    await Promise.all([
      winner.home.releasePreparationLock(),
      winner.home.releasePreparationLock(),
    ]);
    const other = winner.caller === "first"
      ? await secondPromise
      : await firstPromise;
    try {
      expect(other.home.materializationKey).toBe(
        winner.home.materializationKey,
      );
      expect(other.home.homeDir).toBe(winner.home.homeDir);
      expect(other.home.reused).toBe(true);
      await other.home.releasePreparationLock();
      await other.home.verifyAfterReap();
    } finally {
      await other.home.releasePreparationLock().catch(() => undefined);
      await removeHome(winner.home.homeDir);
    }
  });

  it("recovers a stale target lock and removes exact-key crash temp residue without an age-only GC", async () => {
    const selectedIdentity = identity();
    const selected = skill();
    const key = selectedCompanySkillMaterializationKey({
      identity: selectedIdentity,
      entries: [selected],
    }).materializationKey;
    const storeRoot = path.join(os.tmpdir(), "paperclip-company-skills-v1");
    const homesRoot = path.join(storeRoot, "homes");
    const locksRoot = path.join(storeRoot, "locks");
    const orphan = path.join(homesRoot, `.${key}.tmp-orphan`);
    const staleLock = path.join(locksRoot, `${key}.lock`);
    await fs.mkdir(path.join(orphan, "skills", "orphan"), {
      recursive: true,
    });
    await fs.writeFile(path.join(orphan, "skills", "orphan", "file"), "x");
    await fs.chmod(path.join(orphan, "skills", "orphan"), 0o500);
    await fs.chmod(path.join(orphan, "skills"), 0o500);
    await fs.chmod(orphan, 0o500);
    await fs.mkdir(staleLock, { recursive: false });
    await fs.writeFile(
      path.join(staleLock, "owner.json"),
      JSON.stringify({ token: "crashed", createdAt: 0 }),
    );
    const staleTime = new Date(Date.now() - 120_000);
    await fs.utimes(staleLock, staleTime, staleTime);

    const prepared = await prepare({
      identity: selectedIdentity,
      entries: [selected],
    });
    try {
      await expect(fs.access(orphan)).rejects.toThrow();
      await prepared.releasePreparationLock();
      await prepared.verifyAfterReap();
    } finally {
      await prepared.releasePreparationLock().catch(() => undefined);
      await removeHome(prepared.homeDir);
    }
  });
});
