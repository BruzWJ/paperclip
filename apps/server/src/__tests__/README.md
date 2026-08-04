# Server Tests

Server tests must never connect to or provision a database. Exercise service
and route behavior with deterministic per-suite dependency spies or queued
fluent-call mocks. Verify PostgreSQL-specific schema and migration contracts by
inspecting the Drizzle schema and ordinary generated migration SQL as static
artifacts.
