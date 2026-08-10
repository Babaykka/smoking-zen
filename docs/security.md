# Модель безопасности

## Доверие Telegram и сессия

Сервер принимает только сырой `initData`, проверяет HMAC, `auth_date`, доверенное имя бота и предельный возраст, и лишь затем разбирает `start_param`. Разрешены только подписанные `task_<uuid>` и `invite_<43 base64url>`. Неподписанный, просроченный или подменённый параметр не становится навигационной командой. Приглашение погашается атомарно один раз; активный участник не может менять роль через приглашение, а восстановленный участник получает роль самого приглашения. Ссылка на задачу требует активного членства в том же пространстве.

Сессия хранится в HTTP-only cookie с `Secure` и ограниченным сроком. Временный Realtime JWT живёт только в памяти браузера, несёт `smoking_zen_scope=realtime` и workspace id. В Supabase отключаются публичные Realtime-каналы: receive разрешён только приватной теме своего пространства, send из браузера запрещён. RLS остаётся защитным рубежом, а права `anon` и `authenticated` на бизнес-таблицы, RPC и приватный Storage отозваны.

## Данные и файлы

Bucket `workspace-files` приватный. Сервер валидирует сигнатуру, тип, размер и строгий UUID-путь; download URL короткоживущий и не попадает в логи. Удаление метаданных зависит от долговечного подтверждения удаления объекта. Очистка не передаёт провайдеру malformed, folder или чужой workspace path. Глобальное обнаружение сирот работает сервисной ролью, повторно проверяет ссылки перед удалением и сохраняет tombstone завершённой работы.

Smoking Zen не хранит пароли и платёжные реквизиты. Для Bitwarden сохраняются только разрешённая HTTPS-ссылка, подпись и при необходимости последние четыре цифры карты; секрет остаётся в Bitwarden. Self-hosted origin разрешается только явным серверным allowlist. Комментарии, уведомления, audit и backup manifest не должны содержать токены, приватные ключи или содержимое защищённых записей.

## Границы сервисных операций

Маршруты reminders и cleanup требуют точного Bearer-секрета с timing-safe сравнением до чтения тела. Telegram webhook аналогично проверяет secret header до parse. Тела ограничены, ответы имеют `no-store`, а caller не управляет часами, URL, workspace, recipient, path или batch. Дедупликация Telegram `update_id` долговечна. Ограничитель сессий привязан к проверенному Telegram id и не создаёт профили для неавторизованных пользователей.

Сервисная роль, Telegram bot token, webhook secret, session secret, ES256 private key и backup credentials находятся только в Vercel Environment, GitHub Environment, Supabase Vault либо другом утверждённом менеджере секретов. Они не передаются через URI или аргументы процесса и не печатаются. Ошибки хранят только перечислимые redacted-коды. Аудит запускается с gitleaks для tracked, generated и untracked файлов.

## Владельцы и приглашения

Последний активный владелец не удаляется обычным потоком. Перед деактивацией владельца назначается другой, а возврат owner выполняется отдельной подтверждённой операцией, не ссылкой member-invite. Приглашения имеют срок, однократное погашение и не раскрывают причину отказа. Подписи start-параметров и rate limit сдерживают перебор; подозрительные всплески проверяются по безопасным агрегатам, без Telegram payload.

## Резервный контур

Ежедневный backup writer/deleter и freshness read/list используют разные target credentials, поэтому проверка свежести не может изменить историю. Доступы freshness не имеют совместимого fallback на writer-переменные.

Storage-источник использует отдельного Auth-пользователя без workspace membership, короткоживущий session JWT и SELECT-policy только `workspace-files`; generated Supabase S3 keys не считаются read-only. База читается отдельным machine-only SELECT+BYPASSRLS role: это привилегированный read-all доступ, поэтому preflight доказывает отсутствие writes, role memberships, sequence mutation и доступных SECURITY DEFINER routines, а credential изолирован в backup Environment. Соединение обязательно `verify-full` с отдельным CA и жёстко привязано к Supabase project ref, database `postgres` и session-mode Supavisor либо прямому host.

Target расположен у независимого S3-провайдера/failure domain, ограничен prefix и encryption/SSE; `*.supabase.co` не принимается как archive target. Backup writer, freshness reader и restore archive reader используют три разные пары прав. Скрипты отвергают endpoint aliases, conninfo-подмену и root prefix. Manifest публикуется последним после сверки dump, TOC, row counts и каждого ready-объекта с DB size/SHA и содержит source project ref. Restore разрешён только пустому drill-проекту с серверным marker, другим project ref, пустым bucket и точным destructive acknowledgement.
