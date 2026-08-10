# Ротация ключей и токенов

Ротация проводится планово не реже установленного владельцем секрета срока и немедленно при подозрении на утечку. До начала назначьте оператора и проверяющего, зафиксируйте время, затронутый контур и безопасные идентификаторы. Значения секретов, request body, Telegram payload и содержимое `.env` в журнал не копируются.

## Общий порядок

1. Остановите только зависимые задания: Cron через `unschedule_jobs.sql`, backup/freshness — отключением соответствующего GitHub Environment или workflow.
2. Создайте новый секрет у провайдера, не отзывая старый до установки нового во всех потребителях.
3. Обновите staging, выполните один ограниченный запрос и проверьте обезличенный результат.
4. Обновите production Environment или Vault. Для Vault повторно примените `schedule_jobs.sql`, чтобы задания получили актуальное значение при исполнении.
5. Отзовите старый секрет, повторите smoke-проверку и верните расписание.
6. Проверьте журналы на `configuration_error`, 401/403, просроченные lease и новые dead-letter записи.

## Telegram

Bot token перевыпускается через BotFather, затем меняется `TELEGRAM_BOT_TOKEN`. Webhook меняется через Bot API: private curl config вызывает `deleteWebhook(drop_pending_updates=false)`, затем `setWebhook` с точным URL, новым `secret_token` и `allowed_updates=[message,callback_query]`; `getWebhookInfo` подтверждает результат. Token/secret не вводятся в history и не выводятся. Проверьте private `/start`, разрешённый no-op update, одну новую сессию и безопасное тестовое уведомление. HTTP 401 от Telegram считается постоянной ошибкой конфигурации: replay до исправления запрещён.

Изменение username или Mini App short name требует сначала обновить BotFather/domain и доверенные `TELEGRAM_BOT_USERNAME`/`TELEGRAM_MINI_APP_SHORT_NAME`, затем проверить вновь созданные task/invite links. Старые подписанные launch-ссылки должны перестать быть доверенными после смены соответствующего ключевого материала или срока.

## Сессии, JWT и внутренние задания

Для `SESSION_SECRET` используйте двухэтапную смену только если приложение поддерживает временное чтение предыдущего ключа; иначе объявите короткое окно повторного входа и отзовите все старые cookie. Новый ES256 private key создаётся отдельно, публичный ключ с новым `kid` сначала добавляется в Supabase, затем меняются `SUPABASE_JWT_ES256_PRIVATE_KEY` и `SUPABASE_JWT_KID`; старый публичный ключ удаляется после истечения всех пятиминутных Realtime JWT.

`INTERNAL_JOB_SECRET` меняется одновременно в Vercel Environment и Vault `smoking_zen_internal_job_secret`. На время рассинхронизации Cron остановлен. После применения выполните `run_jobs_now.sql`, проверьте 2xx и снова включите расписание.

## Supabase и резервные копии

Service-role key ротируется в Supabase с последующим обновлением серверной среды; publishable key не подменяет сервисный. DB backup-reader password, project CA, Storage backup-reader password, target writer, freshness reader и restore archive reader меняются независимо. Source workflow не хранит session JWT: новый получается на каждый запуск, сверяется с настроенным Auth UUID и исчезает вместе с scratch. После смены Storage reader повторите доказательство list/get allowed и put/delete denied. Сначала подтвердите dry run, затем свежий snapshot и freshness; старые target credentials отзываются после успешного manifest. Drill credentials существуют только на время восстановления.

## Dead-letter после ротации

После устранения причины выберите точный outbox UUID по enum-коду и возрасту, не по тексту. Вызовите `public.replay_notification_outbox(uuid, expected_error_code)` сервисным оператором; `false` не обходят прямым UPDATE. Процедура сама отвергает активный lease, delivered/suppressed и несовпавший error. После `true` запустите один цикл и проверьте revalidation. `delivery_indeterminate` процедура всегда отвергает: автоматический повтор может создать дубль.
