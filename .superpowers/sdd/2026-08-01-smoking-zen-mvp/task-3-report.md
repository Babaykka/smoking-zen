# Task 3 — Supabase schema, RLS, Telegram sessions, and invitations

## Delivered

- Official Telegram Mini App HMAC verification using the two-stage SHA-256 derivation, constant-time digest comparison, a five-minute default lifetime, 30-second future skew, and string-preserved 52-bit Telegram IDs.
- Signed `jose` sessions with 12-hour expiry, per-issue `jti` rotation, bounded parsing, and HttpOnly / SameSite=Lax cookies that are Secure in production.
- Explicit demo-mode environment parsing and fail-closed production parsing for Telegram, Supabase, session, owner, origin, and workspace configuration.
- Dependency-injected Telegram login, session refresh, invitation creation, and invitation redemption route handlers with strict origin checks, bounded JSON parsing, runtime input validation, membership revalidation, safe errors, and `{ data, error, requestId }` envelopes.
- A server-only Supabase access adapter for idempotent owner bootstrap, active membership lookup, hashed invitation creation, and transactional invitation redemption.
- Normalized PostgreSQL tables for workspaces, Telegram-backed users, memberships, statuses, sections, tasks, comments, knowledge, contacts and methods, secure-item links, attachments, reminders, invitations, audit events, notification outbox, and delivery state.
- Version/deletion metadata, cross-workspace foreign keys, visible-row indexes, append-only audit protection, safe audit/outbox payloads, and `(event_id, channel)` delivery uniqueness.
- Non-recursive `SECURITY DEFINER` membership/owner helpers with locked search paths; workspace RLS, private Storage policies, and `workspace:<uuid>` Broadcast authorization.
- Deterministic non-secret seed data with sections `Операции` / `База знаний` and statuses `Новая` / `В работе` / `Ждёт` / `Готово`.

## RED evidence

1. The first focused run failed all three new suites because `env`, Telegram verification, sessions, and route modules did not yet exist.
2. The first implementation run produced two server-session failures from the browser-like test environment's incompatible byte realm and one invalid invitation fixture failure. The server suite was moved to its correct Node runtime, session key bytes were made Node-native, and the fixture was corrected.
3. A self-review regression test sent an oversized JSON body without `Content-Length`; it failed with `expected 400, received 200`, proving the parser trusted the header. The parser now bounds streamed bytes before JSON decoding.
4. PostgreSQL execution exposed two PL/pgSQL ambiguities (`event_id` in the audit trigger and `workspace_id` in invitation conflict handling) that syntax-only tools did not detect. Both were corrected before final verification.

## GREEN evidence

- Focused authentication/session/route suite: `3` files, `18` tests passed.
- Full unit suite: `8` files, `70` tests passed.
- `pnpm lint`: exit `0`.
- `pnpm typecheck`: exit `0`.
- `pnpm build`: optimized production build completed and emitted all four API routes; no credentials were present.
- SQLFluff PostgreSQL parsing and PostgreSQL AST parsing passed for both migrations and the seed.
- Ephemeral PostgreSQL execution passed both migrations twice and the seed once. Runtime checks confirmed stable owner bootstrap, successful first invitation redemption, rejection of the second redemption, `22` public policies, `4` private Storage policies, `2` Realtime policies, `4` statuses, and `2` sections.
- `git diff --check`: exit `0`.

## Refactor and security review

- Raw Telegram `initData`, invitation tokens, session values, signed URLs, Supabase errors, and server configuration are never logged or included in errors.
- Invitation plaintext exists only for generation, hashing, and the one-time response; PostgreSQL stores a 32-byte SHA-256 digest only.
- Invitation redemption locks the matching row, checks expiry and prior use, upserts the member, and marks the invitation used in one database transaction.
- Session refresh verifies the signed session and re-checks the current active membership and role before rotation.
- Cookie-authenticated mutation routes use strict same-origin validation; request bodies are bounded even when `Content-Length` is absent.
- RLS helpers query `workspace_members` behind stable security-definer functions, preventing recursive membership-policy evaluation.

## Remaining integration note

No live Supabase credentials were available. The PostgreSQL execution harness supplied minimal local stand-ins for Supabase-owned `auth`, `storage`, and `realtime` objects and for `extensions.gen_random_uuid()`; production should still apply these migrations in a staging Supabase project before release.
