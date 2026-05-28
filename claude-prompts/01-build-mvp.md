# Claude Code Prompt: Build MVP

You are working in this repository. Build the first functional MVP of the Remote Device Management app.

## Goals

1. Replace the in-memory backend stores with PostgreSQL.
2. Add migrations or a repeatable database setup script.
3. Add local username/password auth with JWT.
4. Add RBAC roles: admin, support, viewer.
5. Build a device enrollment page in the frontend.
6. Build a device detail page.
7. Build command history per device.
8. Keep the code simple, readable, and heavily commented.

## Constraints

- Do not implement arbitrary shell command execution.
- Every command must be allowlisted.
- Every command request must create an audit event.
- Keep the Android agent as a placeholder unless explicitly asked to expand it.

## First Task

Inspect the repo, summarize what exists, then implement PostgreSQL-backed devices and commands.
