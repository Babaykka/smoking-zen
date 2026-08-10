# Готовность staging и production

## Значения, которые предоставляет владелец среды

Для каждого контура нужны BotFather bot token/username/Direct Mini App short name, отдельный webhook secret и HTTPS-origin; Supabase URL, publishable/service-role keys, ES256 signing pair и `kid`; числовой owner Telegram id; session/internal secrets; выделенные DB backup-reader и Storage Auth backup-reader; project CA; независимый зашифрованный S3 target; отдельные freshness/restore archive readers; пустой restore-drill project. Значения вносятся непосредственно в защищённые Environment/Vault. `.env.example` — перечень полей, а не место хранения.

Staging и production не разделяют бота, Supabase project ref, session secret, Vault, backup prefix или drill target. Target обязан принадлежать другому провайдеру/account, не Supabase source. Production-доступы выдаются минимальному числу операторов с MFA и записанным владельцем ротации.

## Безопасный порядок проверки

1. Установить точные Node/pnpm и выполнить frozen install, lint, typecheck, полный Vitest/PGlite, Bats, ShellCheck, production build, весь локальный Playwright matrix без внешних доступов (desktop light/dark, Telegram Web, Android portrait/landscape, iOS WebKit), отдельный `next start` smoke заголовков и браузерного gate, production audit и gitleaks.
2. Создать staging Supabase, применить fresh migrations и повторное применение; подтвердить browser grants/RLS и приватный Realtime с выключенными публичными каналами.
3. В BotFather создать Direct Mini App, Main Mini App/Menu Button; владелец открывает личный чат и выполняет `/start`. Через Bot API private curl config установить webhook с secret token и `allowed_updates`, проверить `getWebhookInfo`, forged/stale initData, одноразовый invite, task isolation, cross-site iframe-cookie в Telegram Web и authenticated group/channel no-op/dedupe.
4. Создать Vault secrets, применить scheduling SQL, выполнить reminders и cleanup вручную, затем проверить suppression, dead-letter, lease recovery, Storage 404 и orphan grace.
5. Создать Auth backup-reader без app membership, подставить его UUID в configure/inspect Storage SQL. В staging доказать: list/get `workspace-files` разрешены, put/delete и другой bucket запрещены. Generated Supabase S3 keys не использовать. Создать DB `smoking_zen_backup_reader`, интерактивно установить пароль, выполнить inspect: read-only/BYPASSRLS, полное SELECT-покрытие, zero write/membership/SECURITY DEFINER. Проверить session-mode Supavisor 5432 или оплаченный direct IPv4, `verify-full` и CA.
6. `show server_version_num` определить фактический major, выбрать закреплённый `BACKUP_POSTGRES_MAJOR`, выполнить dry run, один snapshot, freshness и isolated restore drill. Сверить sourceProjectRef, server/client major, row counts, ready attachments, managed Supabase bootstrap, data-plane RPO/RTO evidence и отсутствие путей/секретов в выводе. Отдельным таймером провести полный service-recovery до Telegram/app smoke; локальный drill не подтверждает project RTO.
7. Повторить конфигурацию отдельными production-значениями, провести smoke без пользовательских данных, включить Cron и GitHub schedules, назначить оповещения и владельца инцидента.

Credentialed проверка провайдеров backup/restore, Telegram, Supabase Cron/Vault и Vercel выполняется в staging как следующий этап запуска. Локальные fake-provider и schema-тесты не объявляются доказательством доступа к облачным аккаунтам. Production не включается до успешного staging snapshot и restore drill.

## Критерии запуска

Production build без секретов успешно завершается; защищённые серверные операции при неполной runtime-конфигурации fail-closed отвечают до эффектов. GitHub production Environment допускает только `main`, требует reviewer, а production jobs имеют такой же job-level guard. В репозитории нет секретов; миграции fresh/upgrade/reapply зелёные; webhook и внутренние маршруты аутентифицируются до чтения тела; напоминания немедленно перепроверяются; cleanup не удаляет родителя до подтверждения Storage; backup manifest публикуется последним и freshness укладывается в 26 часов; drill доказывает data-plane RPO не более 24 часов и data-plane RTO не более 4 часов. Для каждого расписания настроено наблюдение за задержкой GitHub/Cron, а для rotation/dead-letter существует назначенный оператор.

Document-пайплайн в staging отдельно проверяется на том же Node 24 runtime: пассивные PDF/DOCX/XLSX проходят, а active PDF, external/DDE/XLM/network OOXML, превышение 500 PDF-страниц и структурных лимитов завершаются до публикации ready-файла.

## Остановка запуска

Запуск прекращается при любом high advisory, ошибке secret scan, публичном bucket/channel, совпадении source и backup endpoint, неполном manifest, несходящихся row/file hashes, неоднозначной роли владельца, необъяснённом `delivery_indeterminate` или отсутствии свежего восстановления. Возобновление допускается после устранения причины, повторного полного набора проверок и одного ограниченного staging smoke.
