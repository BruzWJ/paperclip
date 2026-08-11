---
title: Goals and Projects
summary: Goal hierarchy and project management
---

Goals define the "why" and projects define the "what" for organizing work.

## Goals

Goals form a hierarchy: company goals break down into team goals, which break down into agent-level goals.

### List Goals

```
GET /api/companies/{companyId}/goals
```

### Get Goal

```
GET /api/goals/{goalId}
```

### Create Goal

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

### Update Goal

```
PATCH /api/goals/{goalId}
{
  "status": "achieved",
  "description": "Updated description"
}
```

Valid status values: `planned`, `active`, `achieved`, `cancelled`.

## Projects

Projects group related tasks toward a deliverable and can be linked to goals.

### List Projects

```
GET /api/companies/{companyId}/projects
```

### Get Project

```
GET /api/projects/{projectId}
```

Returns project details.

### Create Project

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "goalIds": ["{goalId}"],
  "status": "planned",
  "codebase": {
    "repoUrl": "https://github.com/acme/auth-system",
    "localFolder": "/srv/acme/auth-system"
  }
}
```

`repoUrl` records source provenance. It does not clone the repository.
`localFolder` must be absolute on the Paperclip server and becomes the working
directory for agents running tasks in this project. If it is omitted, runs use
an instance-managed task directory.

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

### Get Project Codebase

Board users can read the project execution location without exposing host paths
through ordinary project or plugin responses.

```
GET /api/projects/{projectId}/codebase
```

### Update Project Codebase

```
PATCH /api/projects/{projectId}/codebase
{
  "repoUrl": "https://github.com/acme/auth-system",
  "localFolder": "/srv/acme/auth-system"
}
```

Send `null` for either field to clear it. Clearing both removes the project
codebase; future runs then use instance-managed task directories.
