# Task 8 — end-to-end acceptance, security and responsive release evidence

Status: local implementation and provider-independent verification complete on 2026-08-10 (Europe/Moscow). Final independent security and visual reviews approved the frozen snapshot with no open P0–P2 findings. The final commit is the commit containing this report, with message `test: verify Smoking Zen MVP end to end`; its hash is recorded in the Git handoff.

Base commit: `e356babef1810f0ef1ed5ddce7a38769652ff828` (`feat(task7): add reliable notifications and operations`). Branch: `codex/smoking-zen-mvp`.

No push, deployment, provider mutation or credentialed cloud request was performed.

## Outcome

Task 8 turns the accumulated MVP into a locally verifiable release candidate:

- deferred completion filtering, versioned demo persistence, session-cookie contract, DB-clock restore, Moscow deadlines and focus restoration are complete;
- `Мои`, `Сегодня`, `Просрочено`, `Без исполнителя`, `Все`, combined filters and explicit Today groups use dictionary completion metadata rather than localized names;
- task, knowledge, contact, Safe summary and individual ready attachment archive/Trash/restore/history are reachable and versioned;
- two independent contexts cover the exact N/N+1 conflict, full draft preservation, server adoption and one explicit retry;
- Telegram Web App bridge, theme/viewport/safe-area and versioned BackButton integration are typed; an ordinary browser receives only a server-authored Telegram link;
- request-nonce CSP and security headers cover documents and API errors; the production session is configured and locally contract-tested for Telegram Web's cross-site iframe through an `HttpOnly`, `Secure`, `SameSite=None`, `Partitioned` cookie while preserving Origin checks;
- migrations `0018` and `0019` provide repeatable DB-clock retention, ACL/RLS/Realtime convergence, attachment archive/restore, bounded upload reservations and validation/cleanup leases;
- saved ordinary text and links use one mirrored TypeScript/SQL secret-bearing URL policy with legacy scrub and search exclusion;
- PDF and OOXML validation is structural, bounded and fail-closed for active content, external relationships, XLM/DDE/network formulas and excessive complexity;
- the responsive shell is verified in the local browser matrix and typed Telegram Web fixture at desktop, Android portrait/landscape, iOS WebKit, 320×568, 180 CSS px and actual 200% body zoom.

## RED → GREEN evidence

### Deferred and product acceptance

The initial RED fixtures reproduced ineffective `includeCompleted`, shallow/unversioned demo hydration, the stale cookie test contract, host-clock restore/deadline behavior and missing mobile focus handoff. GREEN: six focused files, 61/61 tests.

Product RED then covered exact views and combined filters, visible Today groups, current-member propagation, Trash/history, attachment archive/restore, owner-only invitation creation and two-context conflicts. Key GREEN checkpoints:

- attachment archive/restore and DB-clock retention: 9 focused files, 79/79;
- history/Trash/product UI: 8 focused files, 49/49;
- exact conflict flow and explicit refresh: 3 focused files, 35/35;
- task/People/Telegram/CSP product group: 5 focused files, 63/63.

### SQL, sessions and saved-content policy

The full `0001`–`0019` chain initially failed on second application because older migrations referenced the final notification shape and an incompatible cleanup RPC return type. The final migration suite applies the ordered chain twice and verifies DB-clock deletion, exact 30-day restore, final ACL/RLS/default privileges, service-role knowledge writes, Realtime isolation, attachment lifecycle and validation/cleanup race ordering.

Security RED batches covered missing knowledge CHECK-helper grants, restore ACL drift, persisted signed URLs, Unicode/control/percent-decoding parity, Telegram Web iframe cookie scope, declared-size quota bypass and direct service-role writes. GREEN evidence:

- first policy batch: 44 expected RED cases converted to 647/647 TypeScript/route/DOM/session tests and 19/19 migration cases;
- Unicode/control parity batch: 9 RED cases converted to 620/620 focused tests and the expanded 21/21 migration suite;
- a 51-vector TypeScript/SQL URL parity probe has zero mismatches; legacy unsafe values are scrubbed and absent from search;
- production cookie set and clear use the same exact `None/Secure/Partitioned` scope; development remains `Lax`.

### Private files and parser hardening

The first active-document RED group had 18 failures while 49 inherited passive-file cases passed. Structural PDF/OOXML validation then reached 75/75. A second RED group added 15 XLM/macrosheet/dialogsheet/case/percent variants; GREEN expanded to 94/94. Final adversarial review added network formulas and repeated-page PDF complexity boundaries; the final validator suite is 100/100.

Independent replay of the former payloads:

- `_xlfn.WEBSERVICE(...)` XLSX is rejected in 4 ms;
- a 25,000-page, 150,334-byte repeated-page PDF is rejected by the 500-page bound in 38 ms;
- 500 pages remain accepted, 501 are rejected before the page loop; indirect object, array/dictionary, node and nesting bounds are also tested;
- ordinary passive PDF, DOCX and XLSX, including benign `SUM`/structured formulas, remain accepted.

### Responsive and accessibility

RED screenshots and geometry assertions reproduced FAB/card/nav collisions at 320×568, clipped CTA and overlapping navigation at actual 200% zoom, missing Knowledge Escape behavior and Telegram 6.0 BackButton warnings. The final focused residual set is 4/4 across Chromium and WebKit; the complete visual specification is 21 passed / 35 intentional project skips.

Independent visual review verified:

- no card/count/FAB/navigation intersections at 320×568;
- no horizontal overflow, clipped CTA, visible-label overlap or FAB collision at body zoom 2;
- visible mobile targets at least 44 px, zero serious/critical Axe findings, clean light/dark/overlay/landscape/safe-area states;
- Knowledge Escape closes and restores its opener;
- Telegram 6.0 performs no unsupported BackButton calls or warnings; 6.1 performs ready/expand/show/hide and native close;
- no hydration, console or page errors in the inspected production flow.

### Release-gate convergence

Release RED exposed two React lint findings, one stale CI-script assertion, one stale normalized route expectation and PGlite worker contention at the former five-second timeout. The implementation removed the lint violations, aligned assertions to public scripts/schema output, and bounded PGlite to four workers with a 30-second per-test ceiling. The normal full run now completes without retries.

## Final local gates on the frozen snapshot

Every command gate below exited with code 0.

- Node `24.18.0`, pnpm `10.14.0`, `CI=true pnpm install --frozen-lockfile`: GREEN.
- ESLint: GREEN.
- TypeScript: GREEN.
- Vitest/PGlite: 56/56 files, 1280/1280 tests.
- Moscow timezone group under both `TZ=UTC` and `TZ=America/New_York`: 3/3 files, 22/22 tests in each environment.
- Bats: 73/73.
- ShellCheck: GREEN.
- `APP_MODE=production pnpm build`: GREEN; 19 static-generation units processed and the complete route manifest, including the protected API surface, compiled.
- Full local Playwright matrix: 76 total, 37 passed, 39 intentional device/project skips.
- Dedicated production `next start` smoke: 2/2 for request nonce/security headers/Telegram bridge ordering and browser gate.
- Visual/a11y focused matrix: 21 passed, 35 intentional project skips; independent visual review APPROVED.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- Production-license inventory reviewed: MIT, Apache-2.0, LGPL-3.0-or-later runtime component, CC-BY-4.0 data, ISC, BSD-3-Clause, MIT/Zlib and 0BSD; new `pdf-lib`/`fast-xml-parser` are MIT and `pdfjs-dist` is Apache-2.0.
- Gitleaks canary plus repository/untracked, `.next/static` and narrowly reviewed `.next/server` scans: GREEN.
- `git diff --check`: GREEN; build-generated `next-env.d.ts` restored to the repository form.
- Independent final security review: APPROVED, no P0–P2.
- Independent final visual/accessibility review: APPROVED, no P0–P2.

Local visual evidence is retained outside Git under `output/playwright/task8-final/`; failure diagnostics, traces, videos and HAR are not release artifacts.

## External release boundary

The following evidence requires protected staging credentials, provider configuration or physical Telegram clients and was intentionally not simulated as a pass:

- real Telegram iOS, Android, Desktop and Web A/K versions, signed login/invite/task links, write access, webhook delivery, notification deep links, keyboard/back/safe-area/theme behavior;
- two separately authenticated staging users proving live Supabase Broadcast updates for task/comment/knowledge/contact/ready attachment, reconnect and revocation;
- hosted Supabase PostgREST/Storage/Broadcast RLS and key configuration, real private file bytes, signed-download expiry, Cron/Vault jobs and dead-letter recovery;
- deployed Vercel HTTPS/CSP/cookie/CORS/bundle/log behavior;
- an under-24-hour manifest-complete backup in the independent target, exact 7/4/12 retention, and isolated credentialed restore with sanitized measured RPO/RTO;
- VoiceOver and TalkBack smoke on available native devices.

Production remains stopped until every item above is recorded in staging according to `docs/readiness.md`. This is an explicit provider-evidence boundary, not a locally passed acceptance result.

No known local implementation concern remains in the frozen snapshot.
