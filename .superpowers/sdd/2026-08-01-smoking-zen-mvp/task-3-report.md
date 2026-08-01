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
- Deterministic non-secret seed data with eight operational sections and statuses `Новая` / `В работе` / `Ждёт` / `Готово`.

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

## Fix round 1 — identity authorization and workspace integrity

### RED evidence

1. `pnpm vitest run src/server/__tests__/supabase-schema.test.ts src/server/__tests__/supabase.test.ts` produced `7` expected failures across `8` probes:
   - `update_own_profile` did not exist and authenticated access to the private authorization helper was unavailable;
   - deleted users/workspaces still retained owner authorization, and a deleted membership allowed owner bootstrap to create a duplicate workspace;
   - the seed returned only `Операции` and `База знаний` instead of the required eight sections;
   - the adapter sent the nonexistent `p_redeemed_at` argument.
2. The first cross-workspace fixture reached the old global outbox uniqueness check before its intended relationship check. After assigning it an unused event, the targeted rerun failed with `promise resolved instead of rejecting`, proving that a cross-workspace event/outbox insert was accepted.

### GREEN evidence

- PostgreSQL runtime and adapter regressions: `2` files, `8` tests passed.
- Focused Telegram/session/route/Supabase suite: `5` files, `26` tests passed.
- Full suite: `10` files, `78` tests passed.
- `pnpm lint`: exit `0`.
- `pnpm typecheck`: exit `0`.
- `pnpm build`: optimized production build and all four API routes completed successfully.
- SQLFluff and PostgreSQL AST parsing passed for both migrations and the seed.
- The checked-in PGlite suite executed both migrations twice and the seed twice. It verified direct RLS denial of an `OWNER_TELEGRAM_ID` preclaim, successful scoped profile updates, revoked owner access for deleted user/membership/workspace records, no duplicate workspace bootstrap, exact eight-section/four-status seed state, exact redemption RPC signature, and cross-workspace foreign-key rejection.
- `git diff --check`: exit `0`.

### Corrections

- Removed the direct `app_users` update policy. Added a locked-search-path `SECURITY DEFINER` profile RPC limited to `display_name`, `username`, and HTTPS `avatar_url`; identity, Telegram ID, deletion state, and record IDs cannot be changed through it.
- Strengthened owner authorization, invitation creation, active membership lookup, and bootstrap/redeem paths to require live users, memberships, and workspaces. Revoked historical owners now fail closed and bootstrap never silently replaces them with a duplicate workspace.
- Removed client-controlled redemption time from the TypeScript contract and Supabase RPC payload; PostgreSQL remains authoritative for redemption time.
- Replaced the seed hierarchy with exactly: `Открытие`, `Ремонт и техника`, `Закупки и склад`, `Зал и сервис`, `Персонал`, `Маркетинг`, `Документы и финансы`, `Безопасность и санитария`.
- Added composite workspace/event/outbox uniqueness and foreign keys so notification rows cannot reference audit/outbox records from another workspace.

### Remaining scope

The two ledgered minor findings were intentionally left unchanged for their assigned review round.
