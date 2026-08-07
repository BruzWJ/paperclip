import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REMOVAL_PROOF_MARKER,
  scanAuthNamespaceOwnership,
  scanBetterAuthSecretBoundary,
  scanBetterAuthTableWriters,
  scanHttpActorBoundary,
  scanProductionImportsOfTestSetup,
  scanRetiredHumanIdentityTokens,
  type CanonicalHumanAuthFile,
} from "./check-canonical-human-auth.ts";

function files(
  entries: Record<string, string>,
): CanonicalHumanAuthFile[] {
  return Object.entries(entries).map(([path, source]) => ({
    path,
    source,
  }));
}

describe("canonical human auth retired-contract scan", () => {
  it("rejects every parallel human identity family in shipped code and active docs", () => {
    const fixtures = [
      ["apps/server/src/config.ts", `const mode = "local_trusted";`],
      ["apps/server/src/middleware/auth.ts", `const source = "local_implicit";`],
      ["apps/ui/src/auth.ts", `const userId = "local-board";`],
      ["apps/server/src/cloud.ts", `const source = "cloud_tenant";`],
      ["packages/shared/src/config.ts", `type Mode = DeploymentMode;`],
      ["packages/cli/src/onboard.ts", `process.env.PAPERCLIP_DEPLOYMENT_MODE;`],
      ["apps/server/src/cloud.ts", `req.get("x-paperclip-cloud-user-id");`],
      ["apps/server/src/claim.ts", `const page = "Board Claim";`],
      ["apps/ui/src/api/auth.ts", `fetch("/api/auth/profile");`],
      ["apps/server/src/routes/auth.ts", "return `paperclip:${source}:${userId}`;"],
      ["apps/server/src/seed.ts", `const source = "paperclip-seed";`],
      ["packages/cli/src/bootstrap.ts", `const purpose = "bootstrap_ceo";`],
      [
        "apps/server/src/invites.ts",
        `const invite = { invitedByUserId: "system" };`,
      ],
      [
        "tests/e2e/bootstrap.spec.ts",
        `const helper = "create-auth-bootstrap-invite";`,
      ],
      [
        "apps/docs/deploy/auth.md",
        "Local setup formerly uses `local_trusted`.",
      ],
    ] as const;

    for (const [file, source] of fixtures) {
      assert.ok(
        scanRetiredHumanIdentityTokens(
          files({ [file]: source }),
        ).length > 0,
        `expected ${file} to be rejected`,
      );
    }
  });

  it("allows only exact-line, test-local removal-proof fixtures", () => {
    const fixturePath = "apps/server/src/__tests__/auth-removal.test.ts";
    const marked =
      `const rejected = "local_trusted"; // ${REMOVAL_PROOF_MARKER}`;
    assert.deepEqual(
      scanRetiredHumanIdentityTokens(
        files({ [fixturePath]: marked }),
      ),
      [],
    );

    assert.ok(
      scanRetiredHumanIdentityTokens(
        files({
          [fixturePath]:
            `// ${REMOVAL_PROOF_MARKER}\nconst stale = "local_trusted";`,
        }),
      ).some((entry) => entry.kind === "removal_proof"),
    );
    assert.ok(
      scanRetiredHumanIdentityTokens(
        files({
          "apps/server/src/auth.ts":
            `const stale = "local_trusted"; // ${REMOVAL_PROOF_MARKER}`,
        }),
      ).some((entry) => entry.kind === "removal_proof"),
    );
    assert.ok(
      scanRetiredHumanIdentityTokens(
        files({
          "tests/e2e/auth.spec.ts":
            `const stale = "local_trusted"; // ${REMOVAL_PROOF_MARKER}`,
        }),
      ).some((entry) => entry.kind === "retired_identity"),
      "E2E is a shipped lifecycle, not test-local database setup",
    );
  });

  it("does not confuse canonical account and authorization concepts with retired identities", () => {
    assert.deepEqual(
      scanRetiredHumanIdentityTokens(
        files({
          "apps/server/src/auth/better-auth.ts": `
            const source = "session";
            const otherSource = "board_key";
            const provenance = "bootstrap_admin_cli";
            const updatePath = "/api/auth/update-user";
          `,
          "apps/docs/auth.md":
            "Every human signs up and signs in through Better Auth.",
        }),
      ),
      [],
    );
  });

  it("allows only the exact onboarding rejection for the retired deployment-mode input", () => {
    const path = "packages/cli/src/commands/onboard.ts";
    const rejection = [
      "if (process.env.PAPERCLIP_DEPLOYMENT_MODE !== undefined) {",
      "  throw new Error(",
      '    "PAPERCLIP_DEPLOYMENT_MODE is unsupported. Configure PAPERCLIP_BIND and PAPERCLIP_DEPLOYMENT_EXPOSURE instead.",',
      "  );",
      "}",
    ].join("\n");
    assert.deepEqual(
      scanRetiredHumanIdentityTokens(files({ [path]: rejection })),
      [],
    );

    assert.ok(
      scanRetiredHumanIdentityTokens(
        files({
          [path]:
            "const deploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;",
        }),
      ).some((entry) => entry.kind === "retired_identity"),
    );
    assert.ok(
      scanRetiredHumanIdentityTokens(
        files({
          [path]:
            'throw new Error("Unsupported PAPERCLIP_DEPLOYMENT_MODE");',
        }),
      ).some((entry) => entry.kind === "retired_identity"),
    );
    assert.ok(
      scanRetiredHumanIdentityTokens(
        files({ [path]: `${rejection}\n${rejection}` }),
      ).some((entry) => entry.kind === "retired_identity"),
      "duplicate rejection owners must not create an allowlisted compatibility surface",
    );
  });
});

describe("Better Auth durable secret boundary", () => {
  it("rejects isolated usable example and default secret mutations", () => {
    const mutations = [
      [
        ".env.example",
        "BETTER_AUTH_SECRET=paperclip-dev-secret",
      ],
      [
        "apps/server/src/config.ts",
        'const secret = process.env.BETTER_AUTH_SECRET ?? "paperclip-dev-secret";',
      ],
      [
        "apps/server/src/config.ts",
        'const DEFAULT_BETTER_AUTH_SECRET = "paperclip-dev-secret";',
      ],
      [
        "apps/docs/deploy/auth.md",
        'BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-paperclip-dev-secret}"',
      ],
    ] as const;

    for (const [file, source] of mutations) {
      const violations = scanBetterAuthSecretBoundary(
        files({ [file]: source }),
      );
      assert.ok(
        violations.some((entry) => entry.kind === "auth_secret"),
        `expected ${file} mutation to be rejected`,
      );
    }
  });

  it("allows empty examples, required external values, and generation guidance", () => {
    assert.deepEqual(
      scanBetterAuthSecretBoundary(
        files({
          ".env.example": "BETTER_AUTH_SECRET=",
          "doc/DOCKER.md":
            "BETTER_AUTH_SECRET=$(openssl rand -hex 32)",
          "docker/docker-compose.yml":
            'BETTER_AUTH_SECRET: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET must be set}"',
        }),
      ),
      [],
    );
  });
});

describe("canonical public auth origin", () => {
  it("rejects Better Auth, Next.js, and parallel Paperclip URL aliases", () => {
    for (const name of [
      "BETTER_AUTH_URL",
      "BETTER_AUTH_BASE_URL",
      "BETTER_AUTH_TRUSTED_ORIGINS",
      "NEXT_PUBLIC_BETTER_AUTH_URL",
      "PUBLIC_BETTER_AUTH_URL",
      "NUXT_PUBLIC_BETTER_AUTH_URL",
      "NUXT_PUBLIC_AUTH_URL",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
      "NEXT_PUBLIC_URL",
      "BASE_URL",
    ]) {
      assert.ok(
        scanRetiredHumanIdentityTokens(
          files({ ".env.example": `${name}=https://alias.example\n` }),
        ).some((entry) => entry.kind === "retired_identity"),
      );
    }
  });

  it("accepts PAPERCLIP_PUBLIC_URL as the sole public origin", () => {
    assert.deepEqual(
      scanRetiredHumanIdentityTokens(
        files({ ".env.example": "PAPERCLIP_PUBLIC_URL=https://paperclip.example\n" }),
      ),
      [],
    );
  });
});

describe("canonical HTTP actor boundary", () => {
  it("rejects nullable and synthetic request-actor identity fallbacks", () => {
    for (const source of [
      'const userId = req.actor.userId ?? "board";',
      'const userId = req.actor.userId || "unknown-user";',
      'const userId = req.actor.userId ?? null;',
      'const agentId = req.actor.agentId ?? "unknown-agent";',
    ]) {
      const violations = scanHttpActorBoundary(
        files({ "apps/server/src/routes/example.ts": source }),
      );
      assert.ok(
        violations.some((entry) => entry.kind === "http_actor"),
      );
    }
  });

  it("requires Express to use the closed canonical actor union", () => {
    const violations = scanHttpActorBoundary(
      files({
        "apps/server/src/types/express.d.ts": `
          declare global {
            namespace Express {
              interface Request {
                actor: { type: "board" | "none"; userId?: string };
              }
            }
          }
        `,
      }),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("canonical RequestActor")
      ),
    );
  });

  it("rejects generic middleware that mints an agent actor", () => {
    const violations = scanHttpActorBoundary(
      files({
        "apps/server/src/middleware/auth.ts": `
          req.actor = {
            type: "agent",
            agentId: "agent-1",
            companyId: "company-1",
            runId: "run-1",
            source: "internal",
          };
        `,
      }),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("must never mint runtime-agent")
      ),
    );
  });

  it("rejects runtime-agent success branches in post-denial route modules", () => {
    for (const source of [
      `
        router.get("/items", async (req, res) => {
          if (req.actor.type === "agent") {
            res.json(await service.list(req.actor.companyId));
          }
        });
      `,
      `
        function actorForMutation(req) {
          return req.actor.agentId
            ? { type: "agent", agentId: req.actor.agentId, runId: req.actor.runId }
            : { type: "user", userId: req.actor.userId };
        }
      `,
      `
        assertBoardOrAgent(req);
        return getRuntimeAgentInfo(req);
      `,
      `
        const actorType = req.actor.type;
        if (actorType === "agent") {
          return service.listForRuntime();
        }
      `,
      `
        const actor = req.actor;
        switch (actor.type) {
          case "agent":
            return service.listForRuntime();
        }
      `,
      `
        const actor = getActorInfo(req);
        return service.mutate(actor);
      `,
      `
        return service.mutate({
          actorType: "user",
          actorId: req.actor.userId,
          agentId: null,
          runId: null,
        });
      `,
    ]) {
      const violations = scanHttpActorBoundary(
        files({ "apps/server/src/routes/example.ts": source }),
      );
      assert.ok(
        violations.some((entry) => entry.kind === "http_actor"),
      );
    }
  });

  it("allows the single generic-agent denial owner and board-only routes", () => {
    assert.deepEqual(
      scanHttpActorBoundary(
        files({
          "apps/server/src/routes/compiled-interface-only.ts": `
            export function denyGenericAgentRest() {
              return (req, res, next) => {
                if (req.actor.type === "agent") {
                  res.status(403).json({ code: "compiled_run_interface_required" });
                  return;
                }
                next();
              };
            }
          `,
          "apps/server/src/routes/example.ts": `
            router.get("/items", (req, res) => {
              assertBoard(req);
              res.json({ userId: req.actor.userId });
            });
          `,
        }),
      ),
      [],
    );
  });

  it("rejects a generic change-consent request endpoint", () => {
    const violations = scanHttpActorBoundary(
      files({
        "apps/server/src/routes/change-consents.ts": `
          router.post("/companies/:companyId/change-consents", async (req, res) => {
            res.status(201).json(await service.request(req.body));
          });
        `,
      }),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("change-consent requests")
      ),
    );
  });

  it("requires the compiled agent_configure consent-request owner", () => {
    const violations = scanHttpActorBoundary(
      files({
        "apps/server/src/services/runtime-agent-action-port.ts": `
          export function createRuntimeAgentActionPort(service) {
            return { agentConfigure: service.configureFromRun };
          }
        `,
        "apps/server/src/index.ts": `
          const agentActions = createRuntimeAgentActionPort(service);
        `,
      }),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("compiled agent_configure")
      ),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("server assembly")
      ),
    );
  });

  it("requires the isolated run-tools and generic REST denial ordering", () => {
    const canonical = `
      app.use("/api", runToolsRoutes(opts.runInterfaceSessionService));
      app.use("/api", rejectRunInterfaceBearerFromGenericApi());
      actorMiddleware(db, {
        resolveSession: opts.resolveSession,
      });
      app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
      app.use("/api", denyGenericAgentRest("REST"));
    `;
    assert.deepEqual(
      scanHttpActorBoundary(
        files({ "apps/server/src/app.ts": canonical }),
      ),
      [],
    );

    const invalid = scanHttpActorBoundary(
      files({
        "apps/server/src/app.ts": `
          actorMiddleware(db, {});
          app.use("/api", runToolsRoutes(service));
          app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
        `,
      }),
    );
    assert.ok(
      invalid.some((entry) =>
        entry.message.includes("run tools must mount")
      ),
    );
  });

  it("rejects retired agent invite provenance outside migration artifacts", () => {
    const violations = scanHttpActorBoundary(
      files({
        "packages/db/schema/invites.ts": `
          export const inviteSources = ["board_api", "agent_api"];
        `,
        "packages/db/migrations/0000_historical.sql": `
          source text check (source in ('board_api', 'agent_api'));
        `,
      }),
    );
    assert.equal(violations.length, 1);
    assert.equal(
      violations[0]?.path,
      "packages/db/schema/invites.ts",
    );
    assert.match(
      violations[0]?.message ?? "",
      /agent_api invite provenance/,
    );
  });

  it("requires the exact Better Auth session-user binding before live-event authorization", () => {
    const canonical = `
      async function authorizeUpgrade() {
        const session = await resolveSession();
        if (
          !(
            isNonEmptyActorId(session?.user?.id)
            && isNonEmptyActorId(session.session?.id)
            && isNonEmptyActorId(session.session.userId)
            && session.session.userId === session.user.id
          )
        ) {
          return null;
        }
        const [roleRow, memberships] = await Promise.all([
          db.select(),
          db.select(),
        ]);
      }

      export function setupLiveEventsWebSocketServer() {}
    `;
    const path = "apps/server/src/realtime/live-events-ws.ts";
    assert.deepEqual(
      scanHttpActorBoundary(files({ [path]: canonical })),
      [],
    );

    for (const mutation of [
      canonical.replace(
        "&& session.session.userId === session.user.id",
        "",
      ),
      canonical.replace(
        "session.session.userId === session.user.id",
        "session.session.userId !== session.user.id",
      ),
    ]) {
      const violations = scanHttpActorBoundary(
        files({ [path]: mutation }),
      );
      assert.ok(
        violations.some((entry) =>
          entry.message.includes("live-events WebSocket authorization")
        ),
      );
    }
  });
});

describe("Better Auth table writer boundary", () => {
  it("follows renamed imports, namespace aliases, local aliases, destructuring, and re-exports", () => {
    const violations = scanBetterAuthTableWriters(
      files({
        "packages/db/schema/auth.ts": `
          export const authUsers = {};
          export const authSessions = {};
        `,
        "packages/db/schema/auth-barrel.ts": `
          export { authUsers as people } from "./auth.js";
          export * from "./auth.js";
        `,
        "apps/server/src/services/direct.ts": `
          import { people as importedPeople } from "../../../../packages/db/schema/auth-barrel.js";
          const localPeople = importedPeople;
          db.insert(localPeople).values({});
        `,
        "apps/server/src/services/namespace.ts": `
          import * as schema from "../../../../packages/db/schema/auth-barrel.js";
          const tables = schema;
          const { authSessions: sessions } = tables;
          tx.update(sessions).set({});
        `,
      }),
    );
    assert.equal(violations.length, 2);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("insert(authUsers)")
      ),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("update(authSessions)")
      ),
    );
  });

  it("rejects raw SQL mutations while allowing reads", () => {
    const violations = scanBetterAuthTableWriters(
      files({
        "apps/server/src/services/sql.ts": `
          db.execute(sql\`INSERT INTO "user" ("id") VALUES ('x')\`);
          db.execute("UPDATE public.account SET password = null");
          db.execute(sql\`DELETE FROM "verification"\`);
          db.select().from(authUsers);
          db.execute(sql\`SELECT * FROM "session"\`);
        `,
      }),
    );
    assert.equal(violations.length, 3);
    assert.ok(
      violations.every((entry) =>
        entry.kind === "auth_table_writer"
      ),
    );
  });

  it("permits only the Better Auth adapter as a Better Auth table writer", () => {
    const allowed = scanBetterAuthTableWriters(
      files({
        "apps/server/src/auth/better-auth.ts": `
          import { authUsers } from "@paperclipai/db";
          db.insert(authUsers).values(input);
        `,
      }),
    );
    assert.deepEqual(allowed, []);

    const unrelatedWriter = scanBetterAuthTableWriters(
      files({
        "packages/db/other.ts": `
          import { authSessions } from "./schema/auth.js";
          export async function rewriteOneSession() {
            db.update(authSessions).set(input);
          }
        `,
      }),
    );
    assert.equal(unrelatedWriter.length, 1);
  });

  it("permits direct rows only as test-local setup", () => {
    assert.deepEqual(
      scanBetterAuthTableWriters(
        files({
          "apps/server/src/__tests__/auth-fixture.ts": `
            import { authAccounts, authUsers } from "@paperclipai/db";
            db.insert(authUsers).values(user);
            db.insert(authAccounts).values(account);
          `,
        }),
      ),
      [],
    );

    assert.equal(
      scanBetterAuthTableWriters(
        files({
          "tests/e2e/auth-fixture.ts": `
            import { authUsers } from "@paperclipai/db";
            db.insert(authUsers).values(user);
          `,
        }),
      ).length,
      1,
    );
  });
});

describe("test-local setup production import boundary", () => {
  it("rejects production, barrel, dynamic, and E2E imports of test setup", () => {
    const violations = scanProductionImportsOfTestSetup(
      files({
        "apps/server/src/__tests__/auth-fixture.ts": `
          import { authUsers } from "@paperclipai/db";
          export async function insertAccountGraph(db: any) {
            await db.insert(authUsers).values({});
          }
        `,
        "apps/server/src/runtime.ts":
          `import { accountGraph } from "./__tests__/auth-fixture.js";`,
        "apps/server/src/index.ts":
          `export * from "./__tests__/auth-fixture.js";`,
        "packages/cli/src/run.ts":
          `const fixture = await import("../../../apps/server/src/__tests__/auth-fixture.js");`,
        "tests/e2e/auth.spec.ts":
          `import "../../apps/server/src/__tests__/auth-fixture.js";`,
        "apps/server/src/__tests__/consumer.test.ts":
          `import { accountGraph } from "./auth-fixture.js";`,
      }),
    );
    assert.equal(violations.length, 4);
    assert.ok(
      violations.every((entry) =>
        entry.kind === "production_test_import"
      ),
    );
  });
});

describe("/api/auth namespace ownership", () => {
  const canonicalOwner = `
    export function createApp(opts: {
      betterAuthHandler: unknown;
    }) {
      const app = express();
      app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
      return app;
    }
  `;
  const canonicalFactory = `
    import { createBetterAuthHandler } from "./auth/better-auth.js";
    const betterAuthHandler = createBetterAuthHandler(auth);
    createApp({ betterAuthHandler });
  `;

  it("accepts exactly one Better Auth wildcard owner and ignores consumers", () => {
    assert.deepEqual(
      scanAuthNamespaceOwnership(
        files({
          "apps/server/src/app.ts": canonicalOwner,
          "apps/server/src/index.ts": canonicalFactory,
          "apps/server/src/client.ts":
            `fetch("/api/auth/get-session");`,
          "apps/server/src/routes/openapi.ts":
            `registry.registerPath({ path: "/api/auth/get-session" });`,
        }),
      ),
      [],
    );
  });

  it("rejects competing absolute, mounted-relative, and fake-handler owners", () => {
    const competing = scanAuthNamespaceOwnership(
      files({
        "apps/server/src/app.ts": canonicalOwner,
        "apps/server/src/index.ts": canonicalFactory,
        "apps/server/src/routes/auth.ts": `
          router.get("/api/auth/profile", profile);
          router.post("/auth/sign-in", customSignIn);
        `,
      }),
    );
    assert.ok(competing.length >= 3);
    assert.ok(
      competing.some((entry) =>
        entry.message.includes("competes")
      ),
    );

    const fake = scanAuthNamespaceOwnership(
      files({
        "apps/server/src/app.ts": `
          app.all("/api/auth/{*authPath}", customAuthHandler);
        `,
      }),
    );
    assert.ok(fake.length >= 2);
  });

  it("fails closed when the namespace has no owner", () => {
    const violations = scanAuthNamespaceOwnership(
      files({
        "apps/server/src/app.ts": "export const app = express();",
        "apps/server/src/index.ts": canonicalFactory,
      }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.message, /expected exactly one/);
  });

  it("rejects optional registration and unproven handler injection", () => {
    const violations = scanAuthNamespaceOwnership(
      files({
        "apps/server/src/app.ts": `
          if (opts.betterAuthHandler) {
            app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
          }
        `,
        "apps/server/src/index.ts": `
          const betterAuthHandler = customHandler;
          createApp({ betterAuthHandler });
        `,
      }),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("unconditional")
      ),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("createBetterAuthHandler")
      ),
    );
  });
});
