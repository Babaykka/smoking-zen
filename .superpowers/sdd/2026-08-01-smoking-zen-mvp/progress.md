# SDD ledger — plan: docs/superpowers/plans/2026-08-01-smoking-zen-mvp.md

Branch base: 9a11159
Task 0: complete (implementation plan and isolated branch established)
Task 1: fix round 1/5 (2 addressed, 0 open; commits b08b024..0f5a2a4)
Task 1: complete (commits 9a11159..0f5a2a4, review clean)
Task 2: minor (deferred): includeCompleted is exposed but not applied by task filtering
Task 2: minor (deferred): persisted demo snapshots receive only shallow top-level validation
Task 2: fix round 1/5 (5 addressed, 2 open; commits 849e9ef..fcfc77d)
Task 2: fix round 2/5 (0 addressed, 2 open; commits fcfc77d..9f10b23)
Task 2: fix round 3/5 (2 addressed, 0 open; commits 9f10b23..72c8e93)
Task 2: complete (commits 0f5a2a4..72c8e93, review clean; 2 deferred minors)
Task 3: minor (deferred): route tests use a session-cookie name that differs from production
Task 3: minor (deferred): production environment parser accepts a non-TLS Supabase URL
Task 3: fix round 1/5 (5 addressed, 0 open; commits dabd8a1..4bc6b2b)
Task 3: complete (commits 72c8e93..4bc6b2b, review clean; 2 deferred minors)
Task 4: minor (deferred): expired restore maps to generic 500 instead of stable 410/422
Task 4: minor (deferred): mobile detail does not move and restore keyboard focus
Task 4: minor (deferred): datetime-local value is interpreted as UTC instead of Europe/Moscow
Task 4: fix round 1/5 (7 original findings addressed, 2 new findings open; commits bc3a190..c3fffa2)
Task 4: fix round 2/5 (2 findings addressed, 1 new finding open; commits c3fffa2..c54183b)
Task 4: fix round 3/5 (1 finding addressed, 0 open; commits c54183b..5a0d4b1)
Task 4: complete (commits 4bc6b2b..5a0d4b1, review clean; 3 deferred minors reserved for Task 8)
Task 5: fix round 1/5 (10 review findings addressed, 0 implementation findings open; 167 tests and full desktop/mobile Playwright gate pass)
Task 5: fix round 2/5 (6 review findings plus integrity follow-ups addressed; commit 301f577)
Task 5: fix round 3/5 (2 review findings addressed; commit d49ef03; independent targeted review APPROVED)
Task 5: minor (deferred to Task 8): production contact restore still performs an application-clock preflight before its database-clock RPC
Task 5: complete (commits 5a0d4b1..d49ef03, review clean; 1 deferred minor)
Task 5: fix round 2/5 (6 review findings plus final integrity audit addressed, 0 implementation findings open; 187 tests and full desktop/mobile Playwright gate pass; convergence migration 0007 added; commit 301f577)
Task 5: fix round 3/5 (2 blockers addressed, 0 implementation findings open; 190 tests and full desktop/mobile Playwright gate pass; historical 0006 fixture and taxonomy recovery migration 0008 added; commit d49ef03; Task 6 begins at 0009)
Task 4: deferred restore-status and mobile Knowledge focus minors resolved in Task 5 round 2; datetime-local Europe/Moscow interpretation remains deferred
Task 6: complete (private quarantine/ready files, strict seven-format validation, fixed Safe summaries/transient reveal, archive/restore, desktop/mobile/exact-360 verification; 288 tests and full Playwright gate pass)
Task 6: fix round 1/5 (10 review findings addressed, 0 open; ambiguous Storage/RPC commits reconciled, DB-authoritative reference-safe cleanup, opaque globally unique object names, Safe URL/reveal/UI hardening; 308 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 6: fix round 2/5 (7 review findings addressed, 0 open; durable 24-hour late-write tombstones and cleanup leases, decoded Safe convergence, strict TXT markup rejection, recovery focus, idempotent legacy migration, inert mobile menu; commit c919588; 344 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 6: fix round 3/5 (2 major and 4 minor review findings addressed, 0 open; stale-lease-safe cleanup, conflict-safe first arm, DB-authoritative expired quarantine retirement, canonical NFKC/zero-width/Unicode-dash Safe parity, stable route rejection, precise shared TXT predicate; commit 4ce991e; 476 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 6: fix round 4/5 (3 major and 2 minor review findings plus post-lock clock audit addressed, 0 open; retained two-remove quarantine tombstones, reasoned service-only retirement, DB-clock arm/completion/finish boundaries, explicit ECMAScript-whitespace parity, strict raw-query decoding, fresh/upgrade/reapply convergence; commit 5b144b8; 698 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 6: fix round 5/5 (2 major and 2 minor review findings addressed, 0 open; non-starving live quarantine discovery, durable first-success cleanup state with an exact separately leased second removal, NULL-safe reason validation, raw literal ECMAScript-whitespace URL parity, fresh/upgrade/reapply convergence; commit 487d376; 778 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 6: pre-deployment upgrade hotfix (recoverable 0013→0014 retired-quarantine guards restored across expired/parent-missing/invalid-content paths; raw leading/trailing ECMAScript whitespace rejected before store access; ready-row lost-key boundary retained for Task 7 orphan reconciliation; commit 4804cbc; 934 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 6: final cleanup-reapply idempotence microfix (durable per-attachment second-removal marker, completed-row backfill exclusion, exact soft-deleted quarantine/path scoping, immutable replay behavior, live/ready constraint enforcement; commit 491954a; 934 tests and 16/20 Playwright pass with 4 intentional project skips)
Task 7: complete in `e356babef1810f0ef1ed5ddce7a38769652ff828` after notification/launch, cleanup/orphan/purge, backup/restore/freshness, operational SQL, CI/security/dependency and Russian runbook convergence; independent Phase 3/4/final Phase 5 reviews APPROVED with no open P0-P2; final gates 46/46 Vitest test files (98 suites, 1066/1066 tests), 73/73 Bats, 16/20 Playwright pass with 4 intentional project skips, build/lint/typecheck/ShellCheck/audit/gitleaks/diff-check/real-tool smoke GREEN; credentialed provider verification remains the explicit Task 8 staging boundary.
Task 8: local implementation complete on the commit containing `task-8-report.md`; deferred acceptance, Trash/history/conflict, Telegram/CSP/session, migrations 0018-0019, upload leases/quotas, structural document validation and responsive/a11y convergence implemented; independent security and visual reviews APPROVED with no open P0-P2; final local gates 56/56 Vitest files (1280/1280), 73/73 Bats, Playwright 37 pass/39 intentional skips plus production runtime 2/2, build/lint/typecheck/ShellCheck/audit/gitleaks/diff-check GREEN; credentialed Telegram/Supabase/Vercel/S3/native/backup evidence remains an explicit staging launch boundary.
