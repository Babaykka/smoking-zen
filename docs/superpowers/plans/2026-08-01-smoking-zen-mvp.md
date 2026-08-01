# Smoking Zen / Штаб Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Telegram Mini App for shared hookah-bar tasks, knowledge, people, files, and safe metadata, with a credential-free demo mode and a Supabase production path.

**Architecture:** A responsive Next.js App Router client consumes a typed `WorkspaceRepository`. Demo mode uses a persistent browser adapter; production route handlers use a Supabase adapter after Telegram session validation. Supabase migrations define the relational schema, RLS, private file policies, audit/outbox behavior, and Realtime broadcasts.

**Tech Stack:** Node.js 24, pnpm, Next.js, React, TypeScript, Zod, TanStack Query, Supabase JS, jose, Vitest, Testing Library, Playwright, ESLint.

## Global Constraints

- Product name is `Smoking Zen / Штаб`; user-facing copy is Russian; workspace timezone is `Europe/Moscow`.
- Mobile navigation is `Сегодня`, `Задачи`, `База`, `Люди`; desktop uses a compact sidebar and detail panel.
- Priority is exactly `1 | 2 | 3 | 4 | 5`, labeled P1 Срочно, P2 Высокий, P3 Обычный, P4 Низкий, P5 Когда-нибудь; new tasks default to P3.
- Initial task statuses are Новая, В работе, Ждёт, Готово and are data, not component constants.
- One workspace and one active assignee per task; all active members edit work content; owners alone manage membership and operational keys.
- All mutable business records carry `workspaceId`, `version`, `createdAt`, `updatedAt`, and nullable `deletedAt`; stale updates return HTTP 409.
- Soft-deleted records remain recoverable for 30 days.
- Files are private, at most 25 MiB, and limited to JPEG, PNG, WebP, PDF, TXT, DOCX, and XLSX without macros; video, HTML, SVG, executables, and mismatched signatures are rejected.
- Safe items store metadata and Bitwarden URLs only. The app must reject passwords, full PAN, CVV/CVC, PIN, OTP, or confirmation codes.
- Secrets, raw Telegram init data, access tokens, signed URLs, and safe external URLs are excluded from logs, search, notifications, and local drafts.
- Demo mode must run without credentials; production mode must fail closed when Telegram or Supabase configuration is incomplete.
- Every behavior change follows RED–GREEN–REFACTOR; tests assert real outcomes rather than implementation details.

---

### Task 1: Foundation, test harness, and responsive shell

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/components/app-shell.tsx`, `src/components/navigation.tsx`, `src/components/ui/*`
- Test: `src/components/__tests__/app-shell.test.tsx`, `tests/e2e/shell.spec.ts`

**Interfaces:**
- Produces `AppShellProps { activeView: ViewKey; onNavigate(view: ViewKey): void; onCreate(): void; children: ReactNode }`.
- Produces `ViewKey = 'today' | 'tasks' | 'knowledge' | 'people'` and Telegram theme/safe-area CSS tokens.

- [ ] Write a failing component test asserting the four Russian navigation labels, current-page semantics, and an accessible global create button.
- [ ] Run `pnpm vitest run src/components/__tests__/app-shell.test.tsx` and confirm failure because the shell does not exist.
- [ ] Scaffold strict Next.js and testing configuration, then implement the minimal responsive shell with Lucide icons and Telegram theme variables.
- [ ] Add the root page with a deterministic loading state and development/demo banner that contains no credential data.
- [ ] Run focused tests, `pnpm lint`, `pnpm typecheck`, and `pnpm build`; confirm clean output.
- [ ] Commit as `feat: scaffold Smoking Zen workspace shell`.

### Task 2: Domain contracts, validation, demo repository, and seed

**Files:**
- Create: `src/domain/types.ts`, `src/domain/schemas.ts`, `src/domain/filters.ts`, `src/domain/search.ts`
- Create: `src/data/workspace-repository.ts`, `src/data/demo-repository.ts`, `src/data/demo-seed.ts`
- Create: `src/providers/workspace-provider.tsx`
- Test: `src/domain/__tests__/schemas.test.ts`, `src/domain/__tests__/filters.test.ts`, `src/data/__tests__/demo-repository.test.ts`

**Interfaces:**
- Produces domain types `Priority`, `Task`, `TaskStatus`, `Section`, `Comment`, `KnowledgeItem`, `Contact`, `WorkspaceMember`, `Attachment`, `SecureItemLink`, `AuditEvent`, `NotificationDelivery`.
- Produces `WorkspaceRepository` methods `snapshot()`, task/comment/knowledge/contact/secure-item CRUD, `search(query)`, `subscribe(listener)`, and `restore(entity,id)`; mutations accept expected `version` and throw `ConflictError` on mismatch.
- Produces `WorkspaceProvider` and `useWorkspace()` for UI consumers.

- [ ] Write failing schema tests for P1–P5, P3 defaults, forbidden secret/card fields, contact methods, and 25 MiB attachment metadata.
- [ ] Run schema tests and confirm expected missing-module failure.
- [ ] Implement domain types and Zod schemas with literal hand-checked fixtures.
- [ ] Write failing repository tests for seed visibility, create/update conflict, soft delete/restore, search exclusion of secure links, and subscription delivery.
- [ ] Run repository tests and confirm the expected unimplemented behavior failures.
- [ ] Implement a browser-safe demo repository with deterministic seed, local persistence, immutable snapshots, version increments, audit events, and subscriber notifications.
- [ ] Run `pnpm vitest run src/domain src/data`, then full unit tests, lint, typecheck, and build.
- [ ] Commit as `feat: add typed workspace domain and demo repository`.

### Task 3: Supabase schema, RLS, Telegram sessions, and invitations

**Files:**
- Create: `supabase/migrations/0001_workspace_schema.sql`, `supabase/migrations/0002_rls_storage_realtime.sql`, `supabase/seed.sql`
- Create: `src/server/env.ts`, `src/server/telegram/verify-init-data.ts`, `src/server/session.ts`, `src/server/supabase.ts`
- Create: `src/app/api/session/telegram/route.ts`, `src/app/api/session/refresh/route.ts`, `src/app/api/invites/route.ts`, `src/app/api/invites/redeem/route.ts`
- Test: `src/server/telegram/__tests__/verify-init-data.test.ts`, `src/server/__tests__/session.test.ts`, `src/app/api/session/__tests__/telegram-route.test.ts`

**Interfaces:**
- Produces `verifyTelegramInitData(raw, botToken, now, maxAgeSeconds): VerifiedTelegramUser` using constant-time HMAC verification.
- Produces `createSession`, `readSession`, `refreshSession`, `clearSession`; session cookies are HttpOnly, Secure in production, SameSite=Lax, 12 hours.
- Produces environment parsing that enables demo mode explicitly and fails closed for incomplete production configuration.

- [ ] Write official-vector-style failing tests for valid, forged, malformed, and stale Telegram init data and 52-bit Telegram IDs.
- [ ] Run the focused verification test and confirm missing implementation failure.
- [ ] Implement verification and session primitives with `jose`, redacting all sensitive error context.
- [ ] Write failing route tests for owner bootstrap, inactive membership denial, one-time 24-hour invitation redemption, and the `{ data, error, requestId }` response envelope.
- [ ] Implement route handlers and server-only Supabase clients.
- [ ] Add normalized tables, constraints, indexes, audit triggers, outbox uniqueness, RLS membership policies, private Storage policies, and workspace Broadcast authorization in migrations; seed the specified sections/statuses and realistic non-secret example data.
- [ ] Run all focused tests, lint, typecheck, build, and SQL static checks.
- [ ] Commit as `feat: add secure Telegram access and Supabase schema`.

### Task 4: Tasks, comments, filters, optimistic concurrency, and Realtime

**Files:**
- Create: `src/features/tasks/*`, `src/app/api/tasks/route.ts`, `src/app/api/tasks/[id]/route.ts`, `src/app/api/comments/route.ts`
- Create: `src/data/api-repository.ts`, `src/data/realtime.ts`
- Test: `src/features/tasks/__tests__/*`, `src/app/api/tasks/__tests__/routes.test.ts`, `tests/e2e/tasks.spec.ts`

**Interfaces:**
- Consumes `WorkspaceRepository`, `Task`, `TaskStatus`, `Priority`, `ConflictError`, and `useWorkspace()`.
- Produces Today and Tasks views, task editor/detail panel, comments, filter chips, and a private `workspace:<workspaceId>` subscription.

- [ ] Write failing UI tests for quick creation, P3 default, one assignee, deadline, status changes, required title, views, filters, and comments.
- [ ] Run focused UI tests and confirm failures for absent behavior.
- [ ] Implement Today/Tasks, responsive detail presentation, compact create flow, accessible priority/status controls, sanitized Markdown/checklists, and conflict recovery UI.
- [ ] Write failing API/repository tests for authenticated CRUD, workspace isolation, stale version 409, soft delete/restore, and Realtime invalidation.
- [ ] Implement production API repository, route handlers, append-only audit writes, and Broadcast subscription with reconnect/backoff.
- [ ] Run task unit/integration tests, then lint, typecheck, build, and the task Playwright flow.
- [ ] Commit as `feat: deliver collaborative task workflow`.

### Task 5: Knowledge, people, contacts, and global search

**Files:**
- Create: `src/features/knowledge/*`, `src/features/people/*`, `src/features/search/*`
- Create: `src/app/api/knowledge/route.ts`, `src/app/api/knowledge/[id]/route.ts`, `src/app/api/contacts/route.ts`, `src/app/api/contacts/[id]/route.ts`, `src/app/api/search/route.ts`
- Test: `src/features/knowledge/__tests__/*`, `src/features/people/__tests__/*`, `src/features/search/__tests__/*`, `tests/e2e/knowledge-people.spec.ts`

**Interfaces:**
- Consumes repository CRUD/search and domain schemas.
- Produces knowledge types `note | instruction | document | link`, team/contact tabs, contact quick actions, and global results grouped by entity type.

- [ ] Write failing tests for knowledge creation/edit/conflict/archive, section selection, safe Markdown rendering, and seeded section visibility.
- [ ] Implement the responsive Knowledge view and API routes.
- [ ] Write failing tests for team/contact tabs, contractor categories, phone/Telegram/WhatsApp quick actions, validation, and inactive-member display.
- [ ] Implement People and contacts with API routes.
- [ ] Write failing tests proving search finds tasks/knowledge/contacts and excludes deleted records, secure external URLs, and private metadata.
- [ ] Implement debounced, keyboard-accessible global search and server query.
- [ ] Run all focused tests, lint, typecheck, build, and Playwright flow.
- [ ] Commit as `feat: add operating knowledge and people directory`.

### Task 6: Private files and Bitwarden-backed safe metadata

**Files:**
- Create: `src/features/files/*`, `src/features/secure-items/*`, `src/server/files/validate-file.ts`
- Create: `src/app/api/files/sign-upload/route.ts`, `src/app/api/files/[id]/download/route.ts`, `src/app/api/secure-items/route.ts`, `src/app/api/secure-items/[id]/route.ts`
- Test: `src/server/files/__tests__/validate-file.test.ts`, `src/features/secure-items/__tests__/*`, `src/app/api/files/__tests__/routes.test.ts`, `tests/e2e/files-safe.spec.ts`

**Interfaces:**
- Produces `validateUpload({ name, declaredMime, size, headerBytes })` returning normalized safe metadata or a Russian validation error.
- Produces private signed upload/download routes, 60-second downloads, orphan cleanup, attachment widgets, and safe-item metadata CRUD.

- [ ] Write failing table-driven tests for each allowed file signature and rejection of oversize, video, HTML, SVG, executable, macro-enabled Office, extension/MIME mismatch, and polyglot-like headers.
- [ ] Implement minimal signature validation and safe randomized object keys.
- [ ] Write failing API tests for membership, private signed URLs, no-store headers, incomplete upload cleanup, and secret-free error/log payloads.
- [ ] Implement private file routes and attachment UI with progress, failure recovery, and mobile picker.
- [ ] Write failing tests for safe metadata, Bitwarden HTTPS host allowlist, masked last four digits, and rejection of password/PAN/CVV/PIN/OTP-like properties.
- [ ] Implement the Safe view under the secondary menu; external URLs are revealed only after an explicit user action and never persisted to drafts/search.
- [ ] Run focused tests, full unit tests, lint, typecheck, build, and Playwright flow.
- [ ] Commit as `feat: add private documents and safe references`.

### Task 7: Telegram notifications, cleanup, backup, CI, and runbooks

**Files:**
- Create: `src/server/notifications/*`, `src/app/api/internal/reminders/route.ts`, `src/app/api/telegram/webhook/route.ts`
- Create: `scripts/backup.sh`, `scripts/restore-drill.sh`, `.github/workflows/ci.yml`, `.github/workflows/backup.yml`
- Create: `.env.example`, `README.md`, `docs/operations.md`, `docs/security.md`
- Test: `src/server/notifications/__tests__/*`, `src/app/api/internal/reminders/__tests__/route.test.ts`, `tests/scripts/backup.bats`

**Interfaces:**
- Produces idempotent notification keys, assignment/mention/due/overdue messages without sensitive content, protected webhook/reminder endpoints, and backup/restore commands.

- [ ] Write failing tests for assignment, mention, 24-hour deadline, 10:00 Moscow overdue cadence, completed-task suppression, deep links, retry safety, and secret-free messages.
- [ ] Implement transactional outbox selection, Telegram delivery, webhook secret verification, and idempotent delivery recording.
- [ ] Write executable tests for backup preflight, independent database/Storage copies, retention selection, missing credential failure, and restore verification.
- [ ] Implement strict-shell backup and restore-drill scripts using `pg_dump` and S3-compatible `rclone`, without printing secrets.
- [ ] Add CI, scheduled backup workflow, redacted environment template, deployment/runbook/security documentation, cron SQL, and production readiness checklist.
- [ ] Run notification tests, script tests, lint, typecheck, full unit suite, and build.
- [ ] Commit as `feat: add notifications and production operations`.

### Task 8: End-to-end security, responsive polish, and final verification

**Files:**
- Modify: all feature/UI files only where a failing acceptance test demonstrates a defect
- Create: `tests/e2e/auth.spec.ts`, `tests/e2e/responsive.spec.ts`, `tests/e2e/accessibility.spec.ts`, `tests/security/*`

**Interfaces:**
- Produces a verified demo preview and a production-ready build artifact; no new product scope.

- [ ] Add failing acceptance tests for forged/stale auth, outsider isolation, complete task flow on two contexts, knowledge/contact search, file rejection, safe-data rejection, soft-delete restore, and 360 px/desktop navigation.
- [ ] Fix only demonstrated gaps through RED–GREEN–REFACTOR.
- [ ] Run unit/integration suites, lint, typecheck, production build, and all Playwright projects.
- [ ] Launch the app, inspect Today/Tasks/Knowledge/People/Safe in mobile and desktop viewports, correct visible layout/accessibility defects, and re-run affected tests.
- [ ] Run dependency audit and secret scan; confirm no high-severity production issue and no committed credentials.
- [ ] Commit as `test: verify Smoking Zen MVP end to end`.

