# Эксплуатация Smoking Zen

## Telegram и среды

Для staging и production создаются отдельные боты. BotFather выдаёт bot token и username; через `/newapp` создаётся Direct Mini App с отдельным short name и HTTPS-адресом. Этот short name обязателен: подписанные ссылки приложения имеют вид `t.me/<bot>/<short_name>?startapp=...`. Тот же Web App можно назначить Main Mini App и Menu Button, но Main Mini App без short name не заменяет Direct Mini App для task/invite links. `TELEGRAM_BOT_USERNAME` и `TELEGRAM_MINI_APP_SHORT_NAME` должны точно совпадать с настройкой BotFather.

Webhook настраивается не в BotFather, а методом Telegram Bot API `setWebhook`. Запрос передаёт точный URL `<APP_ORIGIN>/api/telegram/webhook`, `secret_token`, совпадающий с `TELEGRAM_WEBHOOK_SECRET`, и `allowed_updates` только `message` и `callback_query`. Bot token не вставляют в командную строку или историю shell: URL Bot API, JSON body и заголовки помещают в временный mode-600 curl config в защищённом runner, затем проверяют `getWebhookInfo`. Для ротации сначала вызывают `deleteWebhook` с `drop_pending_updates=false`, меняют token/secret, выполняют `setWebhook`, сверяют URL и отсутствие `last_error_message` через `getWebhookInfo`, после чего удаляют временный config. Ответы и token не копируют в тикеты.

До первой исходящей отправки каждый пользователь должен открыть личный чат с ботом и выполнить `/start`: приложение не запрашивает Telegram write access и бот не может инициировать диалог сам. Сначала задают числовой `OWNER_TELEGRAM_ID`, затем владелец запускает бота и открывает Mini App; только после успешного bootstrap в «Люди → Команда» появляется действие «Создать приглашение». Оно всегда создаёт роль `member`, выдаёт ссылку на 24 часа и не сохраняет токен в рабочем snapshot. Smoke завершается одним безопасным уведомлением без текста задачи и проверкой signed task link. Групповой или channel update после правильного webhook-secret считается поддерживаемым envelope/no-op, получает 200 и долговечную дедупликацию.

| Контур | Бот и Mini App | Supabase | Vercel | Резервные копии |
| --- | --- | --- | --- | --- |
| Staging | отдельные тестовые | отдельный проект | preview/staging Environment | отдельный префикс и drill-проект |
| Production | только рабочие | production-проект | production Environment | независимый зашифрованный target |

В Supabase примените миграции по порядку, импортируйте публичный ES256-ключ с нужным `kid`, оставьте Storage bucket `workspace-files` приватным и выключите dashboard-настройку публичных Realtime-каналов. `SUPABASE_URL` — точный официальный project origin либо точный origin из `SUPABASE_SELF_HOSTED_ORIGINS`; произвольный URL не получает service-role key. В Vercel задайте скалярные переменные из `.env.example`; сервисный ключ, приватный ES256-ключ, Telegram-токен и внутренние секреты доступны только серверу.

## Контроль выпуска в staging

Credentialed выпуск управляется двумя ручными workflow из защищённой `main`, без расписания и production Environment. `Staging release controls` выполняет contour preflight и migration apply/reapply; `Staging data operations` отдельно выполняет одну выбранную операцию `backup-dry-run`, `backup-snapshot`, `freshness` или `restore-drill`. Версионируемый паспорт `config/staging-identities.json` привязывает приложение, Supabase, restore-drill, Telegram, JWT public key и независимый S3 target к одному контуру. Первый release-run выполняется с `migration_mode=none`; `apply` и `reapply` требуют точного `APPLY_STAGING_MIGRATIONS:<project-ref>` и работают одной транзакцией с checksum ledger.

Backup и freshness идут через `staging`. Restore идёт только через main-only Environment `staging-drill` с независимым reviewer, запретом self-review, archive read/list credentials и изменяющими credentials только пустого drill target; требуется `RESTORE_ISOLATED_TARGET:<drill-project-ref>:<snapshot-id>`. SHA-256 считается по точным скачанным байтам artifacts `staging-backup-manifest-<run_id>-<run_attempt>`, `staging-freshness-manifest-<run_id>-<run_attempt>` и `staging-restore-evidence-<run_id>-<run_attempt>`. Первые два содержат повторно скачанный либо фактически проверенный immutable provider `manifest.json`, третий — redacted `staging-restore-evidence.json`. Run ID/attempt и место provider source фиксируются в закрытом review record, потому что redacted candidate не содержит URL и путей.

`STAGING_EVIDENCE_CANDIDATE_VALID` проверяет только структуру candidate и его привязку к commit, migration manifest и публичному паспорту. Он воспроизводим локально и не подтверждает живой provider state. Полномочие для go/no-go дают только сверка исходных artifacts, успешный credentialed run, независимый approval `staging-promotion`, `STAGING_PROMOTION_APPROVED`, promotion receipt и GitHub Environment audit trail. Подробная последовательность и точный формат приведены в `staging-release.md`.

## Напоминания и очистка

В Vault создайте `smoking_zen_app_origin` с точным HTTPS-origin и `smoking_zen_internal_job_secret` формата `[A-Za-z0-9_-]` длиной 32–256. Затем в SQL Editor последовательно выполните `supabase/operations/schedule_jobs.sql` и `inspect_jobs.sql`. Напоминания идут каждые пять минут; очистка — в 00:30 UTC, то есть около 03:30 Москвы. Повторное применение атомарно обновляет две именованные задачи с сохранением job identity. `run_jobs_now.sql` запускает их вручную с телом `{}`, `unschedule_jobs.sql` останавливает, `prune_history.sql` удаляет только Cron history этих двух jobs и pg_net responses, чьи request id записаны в отдельной недампируемой схеме `smoking_zen_ops`. Ни один вызов не передаёт рабочее пространство, получателя, часы, URL или размер пакета.

После запуска проверьте `cron.job_run_details` и `net._http_response`: ожидаются 2xx без содержимого пользовательских данных. Рост ошибок, отсутствие успешного запуска дольше десяти минут для напоминаний или отсутствие очистки дольше 30 часов считается инцидентом.

## Уведомления и dead letter

Просматривайте сервисной ролью только агрегаты outbox: `id`, тип, число попыток, безопасный `last_error_code`, возраст и terminal state. Не выгружайте `chat_id`, текст или URL в тикеты. После устранения причины оператор вызывает единственную bounded-процедуру `select public.replay_notification_outbox(<точный uuid>, <ожидаемый enum-код>);`. Процедура блокирует строку, сверяет ожидаемый terminal/error state, отвергает delivered/suppressed, активный lease и `delivery_indeterminate`, затем сбрасывает attempts и ставит `available_at` по часам БД. `false` означает отсутствие изменений и требует повторной инспекции; прямой `update notification_outbox` запрещён. Откат replay после успешного `true` не имитируется: до нового claim можно остановить reminder job, а после claim решение принимается по новому terminal state. Непосредственно перед Telegram-отправкой обработчик снова проверит членство, назначение, срок и московскую дату; устаревшее уведомление подавляется.

Безопасная последовательность inspect/apply/verify выполняется сервисным оператором с одним UUID и одним ожидаемым enum-кодом:

```sql
select id, kind, attempts, last_error_code, failed_at, dead_letter_at
from public.notification_outbox
where id = '<outbox-uuid>'::uuid;

select public.replay_notification_outbox(
  '<outbox-uuid>'::uuid,
  'configuration_error'
) as replayed;

select id, attempts, available_at, last_error_code, failed_at, dead_letter_at
from public.notification_outbox
where id = '<outbox-uuid>'::uuid;
```

`replayed=true` требует `attempts=0`, очищенных terminal/error полей и новой `available_at`; затем запускается ровно один reminder cycle и снова читается state. `delivery_indeterminate` нельзя подставить в RPC и нельзя обходить прямым UPDATE. Если до claim требуется отмена, оператор оставляет job остановленным и эскалирует; обратной небезопасной процедуры нет.

Доставка фактически однократная в нормальном пути. Если Telegram уже принял сообщение, а фиксация результата потерялась или lease истёк, безопасно определить исход невозможно: повтор может создать дубль, отказ от повтора — потерю. Такой `delivery_indeterminate` не маскируется под ошибку Telegram; оператор сопоставляет время и `message_id` в разрешённой диагностике и принимает явное решение.

## Очистка и сироты

Очистка сначала ставит файлы удалённых родителей в очередь, затем удаляет объекты Storage, сверяет глобальные UUID-сироты и только после долговечного подтверждения очищает метаданные. Quarantine и глобальные сироты требуют двух успешных удалений с интервалом не менее суток. Ошибка провайдера сохраняет запись и получает ограниченный retry; malformed и legacy-пути не отправляются наружу и требуют ручной проверки. Удаление отсутствующего объекта считается успехом.

## Резервные копии и восстановление

Production workflow запускается ежедневно в 23:15 UTC только из `main` через защищённый GitHub Environment с reviewer. Полный snapshot считается завершённым только после последней загрузки schema-v2 `manifest.json` с точным production `sourceProjectRef`; незавершённый каталог не участвует в хранении. Complete schema-v1 или manifest другого project ref в настроенном prefix считается ошибкой смешения контуров и останавливает backup до dump/retention. Политика сохраняет объединение семи новейших snapshots, последнего в четырёх новейших ISO-неделях UTC и последнего в двенадцати новейших месяцах UTC. Проверка freshness в 04:30 UTC использует точные `BACKUP_TARGET_*` endpoint/bucket/prefix/region/path-style production backup, тот же `BACKUP_SOURCE_PROJECT_REF` и отдельные read/list credentials; возраст самого старого компонента должен быть не более 26 часов. Задержка GitHub schedule не оправдывает пропуск и должна поднять оповещение.

Source Storage не использует сгенерированные Supabase S3 keys: они дают полный доступ ко всем bucket и обходят RLS. Создайте отдельного пользователя `backup-reader` в Supabase Auth без app membership. В `configure_backup_reader.sql` один раз подставьте его UUID; `inspect_backup_reader.sql` должен подтвердить точное policy binding. Workflow получает legacy anon key только как S3 secret key, project ref как access key и на каждом запуске обменивает отдельные email/password на короткоживущий session JWT. Ответ Auth ограничен 16 KiB, UUID сверяется с `BACKUP_SOURCE_AUTH_USER_ID`, а JWT не сохраняется. В staging докажите, что этот identity может list/get только `workspace-files`, а put/delete и любой другой bucket запрещены; результаты фиксируют без object paths. `remove_backup_reader.sql` симметрично убирает policy и grants.

Database dump выполняет выделенный machine-only `smoking_zen_backup_reader`. `configure_database_backup_reader.sql` создаёт LOGIN NOINHERIT SELECT+BYPASSRLS, запрещает write/sequence mutation, role membership и исполнение доступных SECURITY DEFINER routines, задаёт read-only transaction и timeouts; пароль устанавливается отдельно интерактивной `\password`, не SQL-файлом и не history. BYPASSRLS — осознанный риск чтения всех app rows ради полного custom dump: credential хранится только в protected backup Environment, никогда не выдаётся приложению или человеку для обычной работы. `inspect_database_backup_reader.sql` и встроенный preflight должны вернуть все safe booleans до каждого dump. Для GitHub runner используйте Supavisor session mode на 5432 с username `smoking_zen_backup_reader.<project_ref>`; transaction mode не подходит exported snapshot. Альтернатива — прямой `db.<project_ref>.supabase.co:5432` при реально доступном IPv4. В обоих случаях host/user/database=`postgres` привязаны к тому же project ref.

Backup target находится у другого S3-провайдера и в другом provider account/project; любой `*.supabase.co` target отвергается. Writer/deleter credentials ограничены выделенным prefix. Freshness получает отдельные `BACKUP_FRESHNESS_TARGET_*` credentials только с read/list, а restore — отдельные `RESTORE_ARCHIVE_*` read/list credentials. Writer keys отсутствуют в обоих контурах.

Перед настройкой workflow выполните `show server_version_num` backup-reader пользователем и возьмите major: например, `170010` означает PostgreSQL 17. `BACKUP_POSTGRES_MAJOR` допускает только закреплённые 17 или 18 и выбирает проверенный клиент 17.10 или 18.4. Backup сравнивает major `pg_dump`, `pg_restore` и сервера до записи, а manifest schema v2 фиксирует server/client version и `sourceProjectRef`. `verify-full` обязателен; CA проекта передаётся отдельным base64 secret, декодируется в временный mode-600 PEM и удаляется при любом исходе. Для drill установите `pg_restore` того же major и CA отдельного target: скрипт сверяет client/server, project ref и manifest до мутаций.

Раз в месяц выполняйте `scripts/restore-drill.sh` в пустом изолированном Supabase-проекте с отдельным project ref и bucket. До запуска Supabase уже должен иметь управляемые `auth`, `storage`, `realtime` и extensions; создайте private `workspace-files` bucket. После подтверждения, что подключение ведёт именно в уничтожаемый drill-проект, выполните target-only marker и проверку:

```sql
alter database postgres set smoking_zen.restore_drill = 'true';
select current_setting('smoking_zen.restore_drill', true), current_database();
```

Затем задайте `RESTORE_TARGET_ENVIRONMENT=restore-drill` и точное `RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT=RESTORE_ISOLATED_TARGET`. Архив восстанавливает только app-owned `public`/`private`; он не содержит управляемые схемы, bucket metadata или operational telemetry. Поскольку dump/restore используют `--no-privileges`, скрипт применяет только versioned `restore_acl_0019.sql`, соответствующий `schemaRevision=0019`, доказывает неизменность checksum всех public rows, отрицательные anon/authenticated и положительные service-role grants, exact Realtime policy/RLS и private bucket. Исторические миграции поверх восстановленных данных не запускаются. Ошибка hardening/ACL smoke завершает drill без Storage и success evidence.

Скрипт также сверяет source project, dump, TOC, хеши, возраст, row counts и ready-вложения. Его evidence измеряет data-plane RPO не более 24 часов и data-plane RTO не более 4 часов от первого preflight до готовых DB/Storage. Отдельно ежемесячно замеряйте полный service-recovery от объявления инцидента: создание/проверку project, keys, deploy, Realtime, Vault/Cron, webhook и финальный Telegram/app smoke; только этот журнал позволяет заявлять полный project RTO ≤4 часов. Providerless локальный drill такого утверждения не даёт. Evidence из `backups/` храните как внутренний артефакт операции, без endpoint, пользователей и секретов. После сохранения evidence выполните `alter database postgres reset smoking_zen.restore_drill;`, проверьте reset и уничтожьте drill project/временные credentials. Никогда не восстанавливайте автоматически в production.

## Наблюдение и инциденты

Ежедневно контролируйте успешный backup/freshness, просроченные lease, terminal notification/cleanup rows и задержку Cron. При инциденте сначала остановите затронутое расписание, сохраните обезличенные идентификаторы и временную шкалу, затем ротируйте скомпрометированный секрет по `rotation-runbook.md`. После исправления выполните один ограниченный ручной запуск, проверьте агрегаты и только потом верните расписание. Ошибки никогда не публикуются вместе с request body, object path, Telegram payload или конфигурацией окружения.
