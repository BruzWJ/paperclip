---
title: Creating a Company
summary: Set up a company, ordinary agents, and the first owned task
---

A company is Paperclip's top-level control-plane boundary. Agents, tasks,
goals, projects, budgets, and company skills are all company-scoped.

## 1. Create the company and goal

Create the company from the board UI, then add a measurable goal. Goals explain
why work exists; they do not invoke a provider by themselves.

## 2. Create an ordinary agent

Configure:

- identity: name, optional display title, capabilities, and reporting edge
- context, action, and mention-reach grants
- explicit company-skill selections
- a separate board/operator-owned adapter revision
- optional budget policy

There is no CEO role, first-agent authority, built-in instruction bundle, or
default provider configuration. A title such as “CEO” is display text only.

The root of the reporting graph may have `reportsTo = null`. Other agents use a
direct reporting edge. Reporting structure constrains delegation and
management; it does not grant ambient task visibility.

## 3. Create the first task

Choose an invokable agent owner and submit an immutable request. Paperclip
creates the task Session, ownership authority, task-execution ref, and
server-resolved run-directory binding before dispatch.

## 4. Add agents and skills deliberately

Use the ordinary agent flow for every additional agent. Company skills are
explicit selections. Paperclip never attaches operational skills or
instructions because an agent is first, root, or has a particular title.

## 5. Monitor

Use task comments, task runs, the activity log, budgets, and board attention
surfaces. Pausing or terminating an agent affects invokability and current
execution; it does not silently reroute work to a CEO or arbitrary fallback
agent.
