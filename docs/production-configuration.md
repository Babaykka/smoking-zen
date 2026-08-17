# Конфигурация production

Production работает только с `APP_MODE=production` и `DEPLOYMENT_ENVIRONMENT=production`. Разбор конфигурации ленивый: build не требует секретов. Защищённые серверные операции, которым нужен неполный набор production-настроек, завершаются generic 503 до чтения тела и эффектов; публичный UI при этом не раскрывает причину или значения. Demo включается исключительно явным `APP_MODE=demo` и не используется в Vercel Production или операционных workflow.

## Vercel

Создайте отдельные Environment для staging и production. Перенесите имена из `.env.example` как скалярные поля: не используйте PostgreSQL URI, JSON с несколькими ключами или секрет в public-переменной. `SUPABASE_PUBLISHABLE_KEY` может участвовать в клиентской конфигурации; `SUPABASE_SERVICE_ROLE_KEY`, Telegram bot token, session/internal/webhook secret и ES256 private key остаются только серверными. `APP_ORIGIN` — точный HTTPS-origin без path, query и завершающего слеша.

Telegram username и Mini App short name считаются доверенной identity, поэтому задаются отдельно для каждого бота. Сервер сам создаёт консервативные ссылки `/startapp` на invite/task и не принимает link или destination от браузера. InitData поступает сырой строкой, подпись проверяется до launch-параметра, а сессия возвращается HTTP-only cookie.

## Supabase

Примените миграции строго по номеру. Импортируйте ES256 public key в trusted signing keys Supabase и укажите его `kid` в `SUPABASE_JWT_KID`. Сервер выдаёт пятиминутный JWT с `smoking_zen_scope=realtime`; браузер хранит его только в памяти и применяет к приватному `workspace:<uuid>` channel. В Realtime Settings выключите public channels. Политика разрешает authenticated только receive своей темы, запрещая Broadcast send и прямое чтение таблиц.

Все бизнес-запросы проходят через Next API. Права `anon`/`authenticated` на public tables, sequences, functions и приватный Storage отозваны; service role создаётся на сервере на запрос. Audit actor из заголовка принимается только для активного пользователя того же workspace, иначе записывается `null`. Bucket `workspace-files` остаётся private.

В Vault вручную создайте `smoking_zen_app_origin` и `smoking_zen_internal_job_secret`, затем примените файлы из `supabase/operations` в порядке, описанном там. Значения origin/secret не находятся в SQL или миграциях. Cron вызывает только фиксированные внутренние маршруты с телом `{}`.

## GitHub Environments

Environment `staging` допускает только `main` и используется ручными workflow `Staging release controls` и `Staging data operations` без расписания. Публичные идентичности фиксируются reviewed-файлом `config/staging-identities.json`; пока в нём `configured: false`, credentialed preflight, migration runner и data operations закрыты. Защищённые variables подтверждают эти значения, а secrets содержат только runtime credentials, project CA, актуальный Vault snapshot, redacted `STAGING_EVIDENCE_BASE64` и минимальные staging backup credentials.

Отдельный Environment `staging-drill` разрешает только `main`, требует независимого reviewer и запрещает self-review. В нём archive credentials имеют только read/list, а изменяющие DB/Storage credentials принадлежат исключительно пустому уничтожаемому project ref из паспорта; app service role, Telegram, production и backup-writer secrets отсутствуют. Он обслуживает только `restore-drill` с acknowledgement `RESTORE_ISOLATED_TARGET:<drill-project-ref>:<snapshot-id>`. Environment `staging-promotion` также main-only, требует независимого reviewer и запрещает self-review, но вообще не содержит provider secrets: reviewer видит candidate до финального approval. Локальный `STAGING_EVIDENCE_CANDIDATE_VALID` подтверждает лишь форму candidate; provider authority дают credentialed run artifacts, receipt и GitHub Environment audit trail. Полный порядок приведён в `staging-release.md`.

Production backup workflow получает machine-only DB SELECT+BYPASSRLS credential, project CA, Auth backup-reader credentials/UUID для короткоживущего Storage session token и независимые target credentials. DB host/user/database и Storage endpoint связаны одним 20-символьным project ref; `verify-full` обязателен. Target принадлежит другому S3 provider/account, не `*.supabase.co`; prefix содержит несколько безопасных сегментов, encryption задаётся явно. Workflow не получает `APP_MODE=demo`, app service role или Telegram token. Freshness использует те же неизменяемые `BACKUP_TARGET_*` coordinates и отдельные `BACKUP_FRESHNESS_TARGET_*` read/list credentials; restore — отдельные `RESTORE_ARCHIVE_*` read/list. Restore drill запускается вручную с отдельным project ref, пустыми app-схемами/bucket, server-side database marker и точным acknowledgement.

GitHub Environment `production` разрешает запуск только из deployment branch `main`, требует reviewer и не допускает self-review. Оба production jobs дополнительно проверяют `github.ref == 'refs/heads/main'`, поэтому ручной dispatch произвольной ветки не получает секреты. Branch protection требует зелёный CI; checkout не сохраняет GitHub credential.

Значение `BACKUP_POSTGRES_MAJOR` получают из read-only `show server_version_num`, а не из предположения о версии Supabase. Workflow разрешает только закреплённые клиенты PostgreSQL 17.10 и 18.4 с официальными SHA256. Сборка клиента обязана подтвердить OpenSSL, zlib, TLS-capable libpq и custom-format dump/TOC smoke. Backup прекращается до dump при несовпадении server/pg_dump/pg_restore major; restore до мутации сравнивает target server и `pg_restore` с version-полями manifest schema v2.

Перед включением production пройдите последовательность из `readiness.md`, операционные проверки из `operations.md` и сценарий ротации из `rotation-runbook.md`. Значения staging нельзя переносить как production-значения, а успешная локальная имитация не заменяет credentialed staging backup/restore.
