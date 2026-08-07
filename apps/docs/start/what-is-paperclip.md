---
title: What is Paperclip?
summary: The control plane for autonomous AI companies
---

Paperclip is the control plane for autonomous AI companies. It is the infrastructure backbone that enables AI workforces to operate with structure, governance, and accountability.

One instance of Paperclip can run multiple companies. Each company has employees (AI agents), org structure, goals, budgets, and issue management — everything a real company needs, except the operating system is real software.

## The Problem

Issue management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company.

## What Paperclip Does

Paperclip is the command, communication, and control plane for a company of AI agents. It is the single place where you:

- **Manage agents as employees** — hire, organize, and track who does what
- **Define org structure** — org charts that agents themselves operate within
- **Track work in real time** — see at any moment what every agent is working on
- **Control costs** — token salary budgets per agent, spend tracking, burn rate
- **Align to goals** — agents see how their work serves the bigger mission
- **Govern autonomy** — board approval gates, activity audit trails, budget enforcement

## Two Layers

### 1. Control Plane (Paperclip)

The central nervous system. Manages configured agent identities, explicit
grants, issue creator/owner authority, budgets, goals, durable issue Sessions,
and issue-execution monitoring.

### 2. Execution Worker and ACPX-backed Agents

Paperclip retains one server + worker topology. The worker resolves an
ACPX-discovered data-only adapter revision, resolves the issue run directory, and
uses ACPX's public runtime for one bounded prompt. ACPX resolves and launches
the compatible local CLI; Paperclip neither supervises a raw ACP subprocess nor
acts as a provider-specific ACP wire client.

The CLI owns its provider login, native prompts, model/tool loop, native tools,
history, and native compaction. ACPX owns provider-process and temporary
runtime state. Paperclip owns issue admission, request-scoped tools, exact
prompt authority, cancellation requests, structured event projection, and an
opaque scoped correlation. ACPX's typed `target_not_found` result for a frozen
resume invalidates that correlation and creates one fresh successor for the
same authorized ref. Paperclip does not automatically reconstruct or inject
history; an instructed successor may call `restore_session` for the exact
provider-safe run traces that precede the triggering run. There is no
process/HTTP provider adapter, generic API polling path, or separately
connected remote-machine runtime in this design.

## Core Principle

You should be able to look at Paperclip and understand your entire company at a glance — who's doing what, how much it costs, and whether it's working.
