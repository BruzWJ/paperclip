<p align="center">
  <img src="https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/assets/banner.jpg" alt="Paperclip is the app people use to manage AI agents for work." width="720" />
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="https://docs.paperclip.ing"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/m4HZY7xNG3"><strong>Discord</strong></a> &middot;
  <a href="https://x.com/papercliping"><strong>Twitter</strong></a> &middot;
  <a href="https://paperclip.ing"><strong>Website</strong></a>
</p>

<p align="center">
  <a href="https://github.com/paperclipai/paperclip/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/paperclipai/paperclip/stargazers"><img src="https://img.shields.io/github/stars/paperclipai/paperclip?style=flat" alt="Stars" /></a>
  <a href="https://discord.gg/m4HZY7xNG3"><img src="https://img.shields.io/discord/000000000?label=discord" alt="Discord" /></a>
</p>

<br/>

<div align="center">
  <video src="https://github.com/user-attachments/assets/773bdfb2-6d1e-4e30-8c5f-3487d5b70c8f" width="600" controls></video>
</div>

<br/>

# Paperclip is the app people use to manage AI agents for work.

Open-source orchestration for teams of AI agents.

**If an AI agent is an _employee_, Paperclip is the _company_.**

Paperclip is a Node.js server and React UI that orchestrates a team of AI agents to run a business. Bring your own agents, assign goals, and track work and costs from one dashboard.

It looks like a task manager. Under the hood: org charts, budgets, governance, goal alignment, and agent coordination.

**Manage business goals, not pull requests.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Define the goal | _"Build the #1 AI note-taking app to $1M MRR."_                    |
| **02** | Configure agents | Coding, research, design, and operations — any locally available ACPX agent. |
| **03** | Approve and run | Review strategy. Set budgets. Hit go. Monitor from the dashboard.  |

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center" colspan="3"><strong>ACPX-compatible local agents</strong><br/><sub>One public runtime contract</sub></td>
  </tr>
</table>

<em>If ACPX can discover and initialize it locally, it can join the company.</em>

</div>

<br/>

## Paperclip is right for you if

- ✅ You want to build **autonomous AI companies**
- ✅ You **coordinate many different agent runtimes** toward a common goal
- ✅ You have **many simultaneous agent processes** running and lose track of what everyone is doing
- ✅ You want agents running **autonomously 24/7**, but still want to audit work and chime in when needed
- ✅ You want to **monitor costs** and enforce budgets
- ✅ You want a process for managing agents that **feels like using a task manager**
- ✅ You want to manage your autonomous businesses **from your phone**

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 Bring Your Own Agent</h3>
Any agent, any runtime, one org chart. Each configured identity runs only explicitly owned task work.
</td>
<td align="center" width="33%">
<h3>🎯 Goal Alignment</h3>
Every task can trace back to the company mission. Agents receive the immutable request for the work they own.
</td>
<td align="center" width="33%">
<h3>💓 Task Executions</h3>
Durable task refs dispatch provider work. Delegation follows authenticated task creator/owner edges.
</td>
</tr>
<tr>
<td align="center">
<h3>💰 Cost Control</h3>
Monthly budgets per agent. When they hit the limit, they stop. No runaway costs.
</td>
<td align="center">
<h3>🏢 Multi-Company</h3>
One deployment, many companies. Complete data isolation. One control plane for your portfolio.
</td>
<td align="center">
<h3>🎫 Task System</h3>
Every conversation traced. Every decision explained. Full tool-call tracing and immutable audit log.
</td>
</tr>
<tr>
<td align="center">
<h3>🛡️ Governance</h3>
Approve hires, override strategy, pause or terminate any agent — at any time.
</td>
<td align="center">
<h3>📊 Org Chart</h3>
Hierarchies, roles, reporting lines. Your agents have a boss, a title, and a job description.
</td>
<td align="center">
<h3>📱 Mobile Ready</h3>
Monitor and manage your autonomous businesses from anywhere.
</td>
</tr>
</table>

<br/>

## Problems Paperclip solves

| Without Paperclip                                                                                                                     | With Paperclip                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ❌ You have many agent processes open and can't track which one does what. On reboot you lose everything.                           | ✅ Tasks have durable, auditable Sessions isolated to the exact task and ownership epoch.                                            |
| ❌ You manually gather context from several places to remind your bot what you're actually doing.                                     | ✅ Explicit context grants compose only the task history the current execution may read.                                               |
| ❌ Folders of agent configs are disorganized and you're re-inventing task management, communication, and coordination between agents. | ✅ Paperclip gives you org charts, task tracking, delegation, and governance out of the box — so you run a company, not a pile of scripts. |
| ❌ Runaway loops waste hundreds of dollars of tokens and max your quota before you even know what happened.                           | ✅ Cost tracking surfaces token budgets and throttles agents when they're out. Management prioritizes with budgets.                    |
| ❌ You have recurring jobs (customer support, social, reports) and have to remember to manually kick them off.                        | ✅ Routines create ordinary scheduled tasks. Management supervises.                                                                    |
| ❌ You have an idea, you have to find your repo, start an agent process, keep a tab open, and babysit it.                             | ✅ Create a task in Paperclip. Its configured owner runs through the same auditable dispatcher.                                      |

<br/>

## Why Paperclip is special

Paperclip handles the hard orchestration details correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Atomic execution.**             | Persisted refs, views, leases, and budget enforcement serialize each exact task execution.                   |
| **Task-scoped continuity.**      | Continuity can resume only within one task/epoch/agent/revision; nothing Paperclip-authored crosses tasks.  |
| **Explicit capabilities.**        | Compiled prompt capabilities appear only when that agent and run are authorized for them.                     |
| **Governance with rollback.**     | Approval gates are enforced, config changes are revisioned, and bad changes can be rolled back safely.        |
| **Goal-aware execution.**         | Tasks carry full goal ancestry so agents consistently see the "why," not just a title.                        |
| **Portable company templates.**   | Export/import orgs, agents, projects, and tasks with secret scrubbing and collision handling.                |
| **True multi-company isolation.** | Every entity is company-scoped, so one deployment can run many companies with separate data and audit trails. |

<br/>

## What's Under the Hood

Paperclip is a full control plane, not a wrapper. Before you build any of this yourself, know that it already exists:

```
┌──────────────────────────────────────────────────────────────┐
│                       PAPERCLIP SERVER                       │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │Identity & │  │ Tasks &  │  │  Task    │  │Governance │  │
│  │  Access   │  │ Sessions  │  │ Execution │  │& Approvals│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Org Chart │  │  Adapter  │  │  Plugins  │  │  Budget   │  │
│  │ & Agents  │  │  Runtime  │  │           │  │ & Costs   │  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Routines  │  │ Secrets & │  │ Activity  │  │  Company  │  │
│  │& Schedules│  │  Storage  │  │ & Events  │  │Portability│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
└──────────────────────────────────────────────────────────────┘
                            ▲
              ┌─────────────┴─────────────┐
              │    ACPX public runtime    │
              │ locally installed agents │
              └───────────────────────────┘
```

### The Systems

<table>
<tr>
<td width="50%">

**Identity & Access** — One Better Auth signup, sign-in, session, profile, and
sign-out lifecycle at every bind and exposure, plus explicit company
memberships, invite flows, and short-lived credentials bound to exact
task-execution refs. Every mutation is traced to a real authenticated actor.

</td>
<td width="50%">

**Org Chart & Agents** — Agents have display identity, direct reporting lines,
explicit context/action grants, provider configuration, selected tools, and
budgets. Org position and title grant nothing.

</td>
</tr>
<tr>
<td>

**Task System** — Tasks carry an immutable request and creator, one current
owner/epoch, company/project/goal/parent links, blocker dependencies, comments,
documents, attachments, work products, labels, and inbox state.

</td>
<td>

**Task Execution** — Persisted refs, leases, and views drive budget checks,
run-directory resolution, dynamic interface compilation, and adapter invocation.
Runs append Paperclip Session events, costs, comments, and audit evidence; no
agent-wide session state crosses tasks.

</td>
</tr>
<tr>
<td>

**Adapter Runtime** — Paperclip resolves the local working directory and
compiles the bounded provider interface for each run. Agents receive only the
context and capabilities authorized for that execution.

</td>
<td>

**Governance & Approvals** — Board approval workflows, execution policies with review/approval stages, decision tracking, budget hard-stops, agent pause/resume/terminate, and full audit logging. Nothing ships without your sign-off.

</td>
</tr>
<tr>
<td>

**Budget & Cost Control** — Token and cost tracking by company, agent, project, goal, task, provider, and model. Scoped budget policies with warning thresholds and hard stops. Overspend pauses agents and cancels queued work automatically.

</td>
<td>

**Routines & Schedules** — Recurring tasks with cron, webhook, and API triggers. Concurrency and catch-up policies. Each routine execution creates a tracked task and wakes the assigned agent — no manual kick-offs needed.

</td>
</tr>
<tr>
<td>

**Plugins** — Instance-wide plugin system with out-of-process workers, capability-gated host services, job scheduling, tool exposure, and UI contributions. Extend Paperclip without forking it.

</td>
<td>

**Secrets & Storage** — Instance and company secrets, encrypted local storage, provider-backed object storage, attachments, and work products. Sensitive values stay out of prompts unless a scoped run explicitly needs them.

</td>
</tr>
<tr>
<td>

**Activity & Events** — Mutating actions, task-execution state changes, cost
events, approvals, comments, and work products are recorded as durable activity
so operators can audit what happened and why.

</td>
<td>

**Company Portability** — Export and import entire organizations — agents, projects, routines, and tasks — with secret scrubbing and collision handling. One deployment, many companies, complete data isolation.

</td>
</tr>
</table>

<br/>

## What Paperclip is not

|                              |                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Not a chatbot.**           | Agents have jobs, not chat windows.                                                                                  |
| **Not an agent framework.**  | We don't tell you how to build agents. We tell you how to run a company made of them.                                |
| **Not a workflow builder.**  | Paperclip models companies — with org charts, goals, budgets, and governance.                                        |
| **Not a prompt manager.**    | Agents bring their own prompts, models, and runtimes. Paperclip manages the organization they work in.               |
| **Not a single-agent tool.** | This is for teams. If you have one agent, you probably don't need Paperclip. If you have twenty — you definitely do. |
| **Not a code review tool.**  | Paperclip orchestrates work, not pull requests. Bring your own review process.                                       |

<br/>

## Quickstart

Open source. Self-hosted. No Paperclip account required.

```bash
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
npx paperclipai onboard --yes
```

Quickstart uses private loopback reachability, generates a durable
`BETTER_AUTH_SECRET` once in the adjacent mode-`0600` environment file, and
serves the same Better Auth signup/sign-in flow used at every other bind. To
listen on a private network instead, choose a bind preset explicitly:

```bash
npx paperclipai onboard --yes --bind lan
# or:
npx paperclipai onboard --yes --bind tailnet
```

If you already have Paperclip configured, rerunning `onboard` keeps the existing config in place. Use `paperclipai configure` to edit settings.

Or manually:

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm db:migrate
pnpm dev
```

This starts the API server at `http://localhost:3100` using the configured
external PostgreSQL target.

> **Requirements:** Node.js >=22.13.0, pnpm 9.15+

<br/>

## FAQ

**What does a typical setup look like?**
Run Paperclip as an application client against a provisioned PostgreSQL server.
For local work, use the repository's Docker Compose database service; hosted
PostgreSQL uses the same connection contract.

If you're a solo entrepreneur you can use Tailscale to access Paperclip on the go. Then later you can deploy to e.g. Vercel when you need it.

**Can I run multiple companies?**
Yes. A single deployment can run an unlimited number of companies with complete data isolation.

**How is Paperclip different from coding agents?**
Paperclip orchestrates supported agents into a company — with org charts, budgets, goals, governance, and accountability.

**Why should I use Paperclip instead of pointing an agent to Asana or Trello?**
Agent orchestration has subtleties in ownership epochs, task-scoped
continuity, authorization, cost monitoring, and governance. Paperclip owns
those control-plane boundaries.

(Bring-your-own-ticket-system is on the Roadmap)

**Do agents run continuously?**
Paperclip starts provider attempts only from admitted task-execution refs.
Assignments, exact mentions, creator updates, and system nudges can admit refs;
schedules do so by having routines create ordinary tasks.

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm dev:server       # Server only
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test             # Cheap default test run (Vitest only)
pnpm test:watch       # Vitest watch mode
pnpm test:e2e         # Playwright browser suite
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

`pnpm test` does not run Playwright. Browser suites stay separate and are typically run only when working on those flows or in CI.

See [doc/DEVELOPING.md](https://github.com/paperclipai/paperclip/blob/master/doc/DEVELOPING.md) for the full development guide.

<br/>

## Roadmap

- ✅ Plugin system (e.g. add a knowledge base, custom tracing, queues, etc)
- ✅ companies.sh - import and export entire organizations
- ✅ Explicit per-agent grants, provider configuration, and tools
- ✅ Scheduled Routines
- ✅ Better Budgeting
- ✅ Agent Reviews and Approvals
- ✅ Multiple Human Users
- ⚪ Artifacts & Work Products
- ⚪ Knowledge Artifacts
- ⚪ Enforced Outcomes
- ⚪ MAXIMIZER MODE
- ⚪ Deep Planning
- ⚪ Work Queues
- ⚪ Self-Organization
- ⚪ Audited Process Improvement
- ⚪ Cloud deployments
- ⚪ Desktop App

This is the short roadmap preview. See the full roadmap in [ROADMAP.md](https://github.com/paperclipai/paperclip/blob/master/ROADMAP.md).

<br/>

## Community & Plugins

Find Plugins and more at [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip)

## Telemetry

Paperclip collects anonymous usage telemetry to help us understand how the product is used and improve it. No personal information, task content, prompts, file paths, or secrets are ever collected. Private repository references are hashed with a per-install salt before being sent.

Telemetry is **enabled by default** and can be disabled with any of the following:

| Method               | How                                                     |
| -------------------- | ------------------------------------------------------- |
| Environment variable | `PAPERCLIP_TELEMETRY_DISABLED=1`                        |
| Standard convention  | `DO_NOT_TRACK=1`                                        |
| CI environments      | Automatically disabled when `CI=true`                   |
| Config file          | Set `telemetry.enabled: false` in your Paperclip config |

## Contributing

We welcome contributions. See the [contributing guide](https://github.com/paperclipai/paperclip/blob/master/CONTRIBUTING.md) for details.

<br/>

## Community

- [Discord](https://discord.gg/m4HZY7xNG3) — Join the community
- [Twitter / X](https://x.com/papercliping) — Follow updates and announcements
- [GitHub project](https://github.com/paperclipai/paperclip) — bugs and feature requests
- [GitHub Discussions](https://github.com/paperclipai/paperclip/discussions) — ideas and RFC

<br/>

## License

MIT &copy; 2026 [Paperclip Labs, Inc](https://paperclip.ing)

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=paperclipai/paperclip&type=date&legend=top-left)](https://www.star-history.com/?repos=paperclipai%2Fpaperclip&type=date&legend=top-left)

<br/>

---

<p align="center">
  <sub>Open source under MIT. Built for people who want to get work done, not babysit agents.</sub>
</p>
