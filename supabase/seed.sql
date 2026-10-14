insert into public.workspaces (id, name)
values ('10000000-0000-4000-8000-000000000001', 'Smoking Zen — демо')
on conflict (id) do update set name = excluded.name;

insert into public.app_users (id, telegram_id, first_name, last_name, username, language_code)
values
  ('20000000-0000-4000-8000-000000000001', '100000001', 'Участник', 'Альфа', 'demo_user_one', 'ru'),
  ('20000000-0000-4000-8000-000000000002', '100000002', 'Участник', 'Бета', 'demo_user_two', 'ru'),
  ('20000000-0000-4000-8000-000000000003', '100000003', 'Участник', 'Гамма', 'demo_user_three', 'ru')
on conflict (id) do update set
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  username = excluded.username,
  language_code = excluded.language_code;

insert into public.workspace_members (id, workspace_id, user_id, display_name, role, active)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Участник Альфа', 'owner', true),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'Участник Бета', 'member', true),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'Участник Гамма', 'member', false)
on conflict (workspace_id, user_id) do update set
  display_name = excluded.display_name,
  role = excluded.role,
  active = excluded.active,
  deleted_at = null;

do $seed_statuses$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'task_statuses' and column_name = 'is_completed'
  ) then
    execute $sql$
      insert into public.task_statuses (id, workspace_id, name, position, is_completed)
      values
        ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Новая', 1, false),
        ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'В работе', 2, false),
        ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Ждёт', 3, false),
        ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Готово', 4, true)
      on conflict (workspace_id, name) do update set
        position = excluded.position,
        deleted_at = null
    $sql$;
  else
    insert into public.task_statuses (id, workspace_id, name, position)
    values
      ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Новая', 1),
      ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'В работе', 2),
      ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Ждёт', 3),
      ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Готово', 4)
    on conflict (workspace_id, name) do update set
      position = excluded.position,
      deleted_at = null;
  end if;
end
$seed_statuses$;

insert into public.sections (id, workspace_id, name, position)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Открытие', 1),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Ремонт и техника', 2),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Закупки и склад', 3),
  ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Зал и сервис', 4),
  ('50000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Персонал', 5),
  ('50000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'Маркетинг', 6),
  ('50000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', 'Документы и финансы', 7),
  ('50000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', 'Безопасность и санитария', 8)
on conflict (id) do update set name = excluded.name, position = excluded.position, deleted_at = null;

insert into public.tasks (
  id, workspace_id, title, description, priority, status_id, section_id, assignee_id, due_at
)
values (
  '60000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Проверить запас кокосового угля',
  'Сверить остаток перед вечерней сменой и отметить объём для следующего заказа.',
  2,
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000002',
  '2026-08-02T15:00:00Z'
)
on conflict (id) do update set
  title = excluded.title,
  description = excluded.description,
  priority = excluded.priority,
  status_id = excluded.status_id,
  section_id = excluded.section_id,
  assignee_id = excluded.assignee_id,
  due_at = excluded.due_at,
  deleted_at = null;

insert into public.knowledge_items (id, workspace_id, title, body, kind, link_url, section_id)
values
(
  '70000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Плотная забивка чаши',
  'Перед подачей проверьте тягу, чистоту колбы и равномерность прогрева.',
  'instruction',
  null,
  '50000000-0000-4000-8000-000000000007'
),
(
  '70000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'Санитарный регламент',
  'Актуальная памятка по ежедневной санитарной обработке.',
  'link',
  'https://example.com/sanitary-guide',
  '50000000-0000-4000-8000-000000000008'
)
on conflict (id) do update set
  title = excluded.title,
  body = excluded.body,
  kind = excluded.kind,
  link_url = excluded.link_url,
  section_id = excluded.section_id,
  deleted_at = null;

insert into public.contacts (id, workspace_id, name, category, notes)
values (
  '80000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Поставщик угля',
  'supplier',
  'Доставка до 12:00 по будням; заявку лучше подтверждать накануне.'
)
on conflict (id) do update set
  name = excluded.name,
  category = excluded.category,
  notes = excluded.notes,
  deleted_at = null;

insert into public.contact_methods (id, workspace_id, contact_id, kind, value, position)
values (
  '81000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  'phone',
  '+79990000000',
  1
)
on conflict (id) do update set value = excluded.value, deleted_at = null;

insert into public.secure_items (
  id, workspace_id, title, purpose, owner, review_date,
  card_bank, card_holder, card_purpose, last_four, external_url
)
values (
  '90000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Касса',
  'Доступ к учётной записи кассы',
  'Управляющий',
  null,
  null,
  null,
  null,
  null,
  'https://vault.bitwarden.com/#/items/example'
)
on conflict (id) do update set
  title = excluded.title,
  purpose = excluded.purpose,
  owner = excluded.owner,
  review_date = excluded.review_date,
  card_bank = excluded.card_bank,
  card_holder = excluded.card_holder,
  card_purpose = excluded.card_purpose,
  last_four = excluded.last_four,
  external_url = excluded.external_url,
  deleted_at = null;
