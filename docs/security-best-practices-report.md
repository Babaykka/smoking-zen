# Отчёт по практикам безопасности

## Резюме

Проверен локальный контур Next.js/React, Telegram-сессии, API, Supabase SQL, приватные файлы и безопасные ссылки. В рассмотренном коде не осталось известных Critical/High-находок. Защита построена послойно: сервер подтверждает личность Telegram, рабочее пространство берётся из сессии, браузерные bearer-роли не имеют прямого доступа к бизнес-данным, изменения версионированы, а файлы проходят закрытый quarantine-процесс.

Этот отчёт не заменяет проверки в реальных Telegram, Supabase, Vercel и backup-аккаунтах. Такие проверки перечислены отдельно и остаются обязательной границей запуска.

## Подтверждённые исправления и контроли

| ID | Уровень | Контроль и свидетельство |
| --- | --- | --- |
| SEC-001 | Critical — исправлено | Сервер принимает только сырой Telegram `initData`, ограничивает размер, отвергает дубли, проверяет HMAC timing-safe сравнением, `auth_date` и точную грамматику launch-параметра ([verify-init-data.ts](../src/server/telegram/verify-init-data.ts#L78), [telegram route](../src/app/api/session/telegram/route.ts#L47)). |
| SEC-002 | High — исправлено | Сессия ограничена 12 часами, подписана с фиксированными issuer/audience/algorithm и выдаётся в `HttpOnly`, `SameSite=None`, `Secure`, `Partitioned` production-cookie для cross-site iframe Telegram Web; локальная разработка использует `SameSite=Lax` ([session.ts](../src/server/session.ts#L5)). Workspace/member/role валидируются из подписанного payload, а не из тела запроса; state-changing запросы по-прежнему требуют точный Origin. |
| SEC-003 | High — исправлено | Все 23 API-маршрута состоят в явном классе аутентификации, имеют проверку метода, общий redacted envelope и поведенческий тест; cookie-модификации требуют точный same-origin ([protected-route-inventory.test.ts](../src/server/__tests__/protected-route-inventory.test.ts#L17), [http.ts](../src/server/http.ts#L15)). |
| SEC-004 | High — исправлено | Финальная SQL-форма включает RLS на бизнес- и операционных таблицах, отозванные `anon`/`authenticated` CRUD/RPC-права и только узкий Realtime SELECT-контракт. Полная цепочка миграций проверяется повторным применением и direct-bearer denial ([migration-replay.test.ts](../src/server/__tests__/migration-replay.test.ts#L132)). |
| SEC-005 | High — исправлено | Удаление и восстановление используют часы БД, NULL-safe optimistic lock, точную 30-дневную границу и append-only audit без Storage path/hash/секретного содержимого ([0018 migration](../supabase/migrations/0018_task8_acceptance_security.sql#L11)). UI загружает не более 200 последних событий и показывает до 50 событий сущности ([task-api.ts](../src/server/task-api.ts#L160), [audit-history.tsx](../src/components/audit-history.tsx#L15)). |
| SEC-006 | High — исправлено | Private Storage принимает только allowlist форматов до 25 МиБ, сверяет фактические bytes/magic и безопасно перекодирует raster. PDF разбирается структурно и fail-closed отклоняет actions, JavaScript, формы/XFA, шифрование, вложения и чрезмерную сложность; OOXML отклоняет macros/ActiveX/OLE, внешние relationships, DDE/XLM и сетевые формулы. ZIP traversal/бомбы ограничены. Каждый grant резервирует полные 25 МиБ в долговечной member/workspace quota; validation и cleanup сериализованы DB leases ([validate-file.ts](../src/server/files/validate-file.ts#L33), [0019 migration](../supabase/migrations/0019_task8_upload_abuse_guards.sql#L25)). |
| SEC-007 | High — исправлено | Пароли, CVV/CVC/PIN/OTP и полные карты отклоняются в обычных сущностях и Safe. Все URL в обычных сохраняемых текстах проходят одну TS/SQL-политику: query/hash, control/Unicode-space и opaque access token запрещены, legacy-значения очищаются и не попадают в поиск. Safe принимает только origin либо канонический Bitwarden UUID deep-link на точном allowlist ([schemas.ts](../src/domain/schemas.ts#L23), [schemas.ts](../src/domain/schemas.ts#L76), [schemas.ts](../src/domain/schemas.ts#L238)). |
| SEC-008 | Medium — исправлено | Browser config парсится отдельно и fail-closed: service-role/`sb_secret_`/неверная JWT role не сериализуются. Production CSP имеет request nonce, `strict-dynamic`, Telegram frame allowlist и точные Supabase HTTPS/WSS origins; API всегда `no-store`, включены HSTS/nosniff/referrer/permissions headers, отключён `X-Powered-By` ([env.ts](../src/server/env.ts#L163), [content-security-policy.ts](../src/security/content-security-policy.ts#L17), [proxy.ts](../src/proxy.ts#L5), [next.config.ts](../next.config.ts#L3)). |

## Открытые наблюдения низкого риска

### SEC-009 — официальный Telegram bridge без SRI

- Rule ID: REACT-SRI-001
- Severity: Low
- Location: `src/app/layout.tsx`, корневой `<head>`.
- Evidence: parser-blocking `https://telegram.org/js/telegram-web-app.js?63` загружается до приложения; официальный URL не публикует стабильный SRI-контракт.
- Impact: компрометация ресурса Telegram эквивалентна исполнению стороннего JavaScript в origin Mini App.
- Fix: при появлении официального неизменяемого hash/version contract закрепить integrity; самовольное зеркало сейчас повышает риск рассинхронизации с Telegram-клиентами.
- Mitigation: единственный сторонний script, точный HTTPS host/version, production nonce CSP и отсутствие секретов/долгоживущих токенов в browser storage.
- False positive notes: проверить фактический response URL/CSP в staging Telegram Web; не считать отсутствие SRI устранённым инфраструктурой без свидетельства.

### SEC-010 — inline CSS разрешён, inline JavaScript запрещён

- Rule ID: REACT-CSP-001
- Severity: Low
- Location: `src/security/content-security-policy.ts`, директива `style-src`.
- Evidence: `style-src 'self' 'unsafe-inline'`; production `script-src` не содержит `unsafe-inline`/`unsafe-eval`.
- Impact: при отдельной HTML-инъекции возможна подмена визуального оформления, но не прямое выполнение JavaScript через CSP.
- Fix: после проверки совместимости Next/Telegram перейти на nonce/hash для styles.
- Mitigation: React escaping, отсутствие raw HTML sinks, `object-src 'none'`, `base-uri`/`form-action` self и строгий script nonce.
- False positive notes: это defense-in-depth улучшение, а не подтверждённый XSS; пользовательский HTML не рендерится.

## Обязательные проверки только в staging

- Hosted Supabase: применить миграции дважды, подтвердить фактические Storage RLS, private Broadcast receive/send isolation и отзыв доступа после деактивации участника.
- Telegram: forged/stale/future `initData`, одноразовый invite, task deep-link isolation, webhook secret, личный `/start`, реальная cross-site iframe-сессия Telegram Web, Desktop/Web/iOS/Android BackButton, safe-area и темы.
- Vercel/edge: HTTPS, runtime CSP/nonce, Telegram iframe, CORS для `https://web.telegram.org`, attachment download headers и отсутствие секретов/source maps в bundle/artifacts/logs.
- Cron/Vault/notifications: реальные расписания, повторная валидация получателя, идемпотентность, dead-letter и redacted Telegram payload.
- Backup: независимый S3 target, свежий manifest, 7/4/12 retention, checksum/row counts и полное изолированное восстановление с измеренными RPO/RTO.
- Bitwarden Organization: доступность разрешённых item links и отсутствие фактических секретов в базе, поиске, уведомлениях и audit.

Локальные fake-provider/schema/E2E тесты подтверждают поведение кода, но не подтверждают права и конфигурацию облачных аккаунтов.
