-- Recover custom taxonomy values tombstoned by the historical Task 5 migration,
-- but only when visible records in an active workspace still require them.

do $recover_referenced_custom_taxonomy$
begin
  update public.task_statuses as status
  set deleted_at = null
  where status.deleted_at is not null
    and status.name not in ('Новая', 'В работе', 'Ждёт', 'Готово')
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = status.workspace_id and workspace.deleted_at is null
    )
    and exists (
      select 1 from public.tasks as task
      where task.workspace_id = status.workspace_id
        and task.status_id = status.id
        and task.deleted_at is null
    );

  update public.sections as section
  set deleted_at = null
  where section.deleted_at is not null
    and section.name not in (
      'Открытие', 'Ремонт и техника', 'Закупки и склад', 'Зал и сервис',
      'Персонал', 'Маркетинг', 'Документы и финансы', 'Безопасность и санитария'
    )
    and exists (
      select 1 from public.workspaces as workspace
      where workspace.id = section.workspace_id and workspace.deleted_at is null
    )
    and (
      exists (
        select 1 from public.tasks as task
        where task.workspace_id = section.workspace_id
          and task.section_id = section.id
          and task.deleted_at is null
      )
      or exists (
        select 1 from public.knowledge_items as knowledge
        where knowledge.workspace_id = section.workspace_id
          and knowledge.section_id = section.id
          and knowledge.deleted_at is null
      )
    );
end;
$recover_referenced_custom_taxonomy$;
