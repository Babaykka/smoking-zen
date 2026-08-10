# Планировщик Supabase

Эти SQL-файлы относятся к конкретному развёртыванию и поэтому не входят в миграции схемы. Перед применением в Vault создаются две записи: `smoking_zen_app_origin` с точным HTTPS-origin без path/port и `smoking_zen_internal_job_secret` формата `[A-Za-z0-9_-]{32,256}`, совпадающий с серверным `INTERNAL_JOB_SECRET`.

Порядок применения: открыть SQL Editor владельца проекта, выполнить `schedule_jobs.sql`, затем `inspect_jobs.sql`. Повторное выполнение атомарно обновляет две именованные задачи через `cron.schedule(name,...)` с устойчивыми job id. `run_jobs_now.sql` отправляет по одному запросу с телом `{}` и записывает request id в недампируемую `smoking_zen_ops`; `inspect_jobs.sql` связывает только эти id с pg_net. Для отката применяется `unschedule_jobs.sql`. `prune_history.sql` удаляет только историю двух jobs и связанные с ledger HTTP responses.

Storage source reader настраивается `configure_backup_reader.sql`: замените единственный `NULL` на UUID отдельного `auth.users`, не состоящего в workspace. Тем же UUID выполните `inspect_backup_reader.sql`; удаление — `remove_backup_reader.sql`. DB dump role создаётся `configure_database_backup_reader.sql`, пароль задаётся интерактивной `\password`, проверка — `inspect_database_backup_reader.sql`, удаление — `remove_database_backup_reader.sql`. Эти операции сначала проходят staging proof из `docs/readiness.md`.

Расписание хранится в UTC: напоминания запускаются каждые пять минут, очистка — в 00:30 UTC, то есть около 03:30 по Москве. URL, workspace, recipient, время и размер пакета не принимаются от планировщика: область работы, часы и лимиты определяются сервером и базой данных.
