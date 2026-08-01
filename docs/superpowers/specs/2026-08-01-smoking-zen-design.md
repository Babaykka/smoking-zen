# Smoking Zen / Штаб — Design Specification

## Product

Smoking Zen / Штаб is a private, Russian-language Telegram Mini App for operating one hookah bar. It is the shared place for tasks, operating knowledge, team members, contractors, documents, and links to secrets held in Bitwarden.

The primary experience is Telegram on mobile and desktop. A direct browser visit shows a safe development preview in demo mode or an “Open in Telegram” gate in production.

## Experience

- Mobile navigation: Сегодня, Задачи, База, Люди, plus a global create button.
- Desktop navigation: compact sidebar, content column, optional detail panel.
- Telegram theme variables, safe-area insets, accessible light/dark themes, and no decorative clutter.
- Task creation needs only a title. Defaults are status Новая and priority P3.
- Priority is exactly P1–P5; one active assignee; optional deadline and section.
- Today prioritizes overdue, due today, and unassigned P1/P2 work.
- Knowledge contains notes, instructions, documents, and links.
- People contains team members and external contacts.
- Safe stores metadata and Bitwarden links only; it rejects password-like fields and complete payment card data.

## Architecture

- Next.js App Router, React, strict TypeScript, Zod, TanStack Query, Vitest, Testing Library, Playwright.
- A typed repository boundary lets the UI use a deterministic local demo adapter without credentials and a Supabase-backed adapter in production.
- Next.js route handlers validate Telegram sessions and expose task, comment, knowledge, contact, invitation, file, secure-item, and reminder APIs.
- Supabase supplies Postgres, RLS, private Storage, and Broadcast Realtime.
- Every business row belongs to one workspace and supports optimistic concurrency with `version` plus recoverable deletion through `deleted_at`.

## Security

- Telegram raw `initData` is verified server-side with HMAC-SHA-256, constant-time comparison, and an age limit.
- Production access requires active workspace membership; only owners manage members and operational secrets.
- Signed file URLs last 60 seconds. Uploads use an allowlist, a 25 MiB limit, and extension/MIME/magic-byte validation.
- Passwords, tokens, complete card numbers, CVV/CVC, PINs, Telegram init data, and signed URLs never enter logs, analytics, local drafts, search, or notification bodies.
- All runtime secrets remain in server-only environment variables.

## Operations

- Staging and production use separate Telegram bots, domains, and Supabase projects.
- Supabase migrations and seed data are versioned.
- CI runs lint, typecheck, unit/integration tests, production build, and Playwright smoke tests.
- Database and Storage are backed up independently to an S3-compatible target with documented retention and restore drills.

