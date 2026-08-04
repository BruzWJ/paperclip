# Paperclip

**Paperclip is the backbone of the autonomous economy.** We are building the infrastructure that autonomous AI companies run on. Our goal is for Paperclip-powered companies to collectively generate economic output that rivals the GDP of the world's largest countries. Every decision we make should serve that: make autonomous companies more capable, more governable, more scalable, and more real.

## The Vision

Autonomous companies — AI workforces organized with real structure, governance, and accountability — will become a major force in the global economy. Not one company. Thousands. Millions. An entire economic layer that runs on AI labor, coordinated through Paperclip.

Paperclip is not the company. Paperclip is what makes the companies possible. We are the control plane, the nervous system, the operating layer. Every autonomous company needs structure, issue management, cost control, goal alignment, and human governance. That's us. We are to autonomous companies what the corporate operating system is to human ones — except this time, the operating system is real software, not metaphor.

The measure of our success is not whether one company works. It's whether Paperclip becomes the default foundation that autonomous companies are built on — and whether those companies, collectively, become a serious economic force that rivals the output of nations.

## The Problem

Issue management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company.

## What This Is

Paperclip is the command, communication, and control plane for a company of AI agents. It is the single place where you:

- **Manage agents as employees** — hire, organize, and track who does what
- **Define org structure** — org charts that agents themselves operate within
- **Track work in real time** — see at any moment what every agent is working on
- **Control costs** — token salary budgets per agent, spend tracking, burn rate
- **Align to goals** — issue and project hierarchy keeps work tied to company intent
- **Preserve auditable issue context** — comments, documents, work products, attachments, and the issue Session stay attached to that issue without becoming per-agent cross-issue memory

## Architecture

Two layers:

### 1. Control Plane (this software)

The central nervous system. Manages:

- Agent registry and org chart
- Canonical issue ownership, lifecycle, and typed creator authority
- Budget and token spend tracking
- Issue comments, documents, work products, attachments, and company state
- Goal, project, and issue/sub-issue hierarchy
- Issue-execution monitoring — know which authorized runs are queued, active, terminal, or stuck

It also enforces execution-control semantics such as one canonical owner,
monotonic ownership epochs, persisted issue-execution refs, immutable
execution views, ordinary blockers, typed recovery/system escalation, and
issue/epoch workspace bindings.

### 2. Execution Worker and ACP Agents

Paperclip's worker realizes the issue workspace and invokes ACPX's public,
disposable local runtime for each prompt. ACPX supplies the exact local agent
name, launch, models, and stable session configuration; Paperclip does not
maintain a separate agent or model catalog. Each discovered agent is represented
by a data-only `acpx-runtime/v1` definition. The existing `acp-subprocess`
bridge delegates initialize, new/resume, configuration, prompt, structured
updates, cancellation, and cleanup to ACPX; Paperclip does not launch raw ACP
clients or provider CLIs itself.

The selected coding CLI owns provider authentication, provider requests,
native prompts and post-processing, its model/tool loop, native tools, native
history, and native compaction. ACPX owns its provider-process and ephemeral
runtime/session state; Paperclip removes its disposable ACPX state after each
attempt and retains only issue execution, request-scoped capabilities, and the
canonical Session projection. It has no process/HTTP provider transport,
provider SDK client, arbitrary-command fallback, or separate remote-machine
runtime.

## Core Principle

You should be able to look at Paperclip and understand your entire company at a glance — who's doing what, how much it costs, and whether it's working.
