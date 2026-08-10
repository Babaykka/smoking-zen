'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { SafeMarkdown } from '@/components/safe-markdown';
import { AuditHistory } from '@/components/audit-history';
import { AttachmentWidget } from '@/features/files/attachment-widget';
import { ConflictError } from '@/data/workspace-repository';
import { matchesTaskFilter, type TaskDeadlineFilter, type TaskFilter } from '@/domain/filters';
import { formatMoscowDateTime, fromMoscowDateTimeLocal, moscowDateKey, toMoscowDateTimeLocal } from '@/domain/moscow-time';
import type { Priority, SearchNavigationTarget, Task } from '@/domain/types';
import { useTelegramBackButton } from '@/lib/use-telegram-back-button';
import { useWorkspace } from '@/providers/workspace-provider';

export type TaskWorkspaceProps = {
  activeView: 'today' | 'tasks';
  createRequest: number;
  searchTarget?: SearchNavigationTarget;
  onSearchTargetConsumed?: (requestKey: number) => void;
  launchTaskId?: string;
  onLaunchTaskConsumed?: () => void;
  now?: Date;
};

type TaskDraft = Pick<Task, 'title' | 'description' | 'priority' | 'statusId' | 'sectionId' | 'assigneeId' | 'dueAt'>;
type TaskView = 'my' | 'today' | 'overdue' | 'unassigned' | 'all';
type TaskViewState = { source: TaskWorkspaceProps['activeView']; value: TaskView };

const PRIORITIES: Priority[] = [1, 2, 3, 4, 5];

function todayRank(task: Task, now: Date): number {
  const today = moscowDateKey(now);
  const due = task.dueAt ? moscowDateKey(new Date(task.dueAt)) : undefined;
  if (due && due < today) return 0;
  if (due === today) return 1;
  if (!task.assigneeId && task.priority <= 2) return 2;
  return 3;
}

export function orderTodayTasks(tasks: Task[], now: Date): Task[] {
  return [...tasks].sort((left, right) => {
    const rank = todayRank(left, now) - todayRank(right, now);
    if (rank) return rank;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function groupTodayTasks(tasks: Task[], now: Date): Array<{ key: string; title: string; tasks: Task[] }> {
  const ordered = orderTodayTasks(tasks, now);
  const definitions = [
    { key: 'overdue', title: 'Просрочено', rank: 0 },
    { key: 'today', title: 'На сегодня', rank: 1 },
    { key: 'urgent-unassigned', title: 'P1/P2 без исполнителя', rank: 2 },
    { key: 'recent', title: 'Последние изменения', rank: 3 },
  ];
  return definitions.map((definition) => ({
    key: definition.key,
    title: definition.title,
    tasks: ordered
      .filter((task) => todayRank(task, now) === definition.rank)
      .slice(0, definition.key === 'recent' ? 5 : undefined),
  }));
}

function draftFrom(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    statusId: task.statusId,
    sectionId: task.sectionId,
    assigneeId: task.assigneeId,
    dueAt: task.dueAt,
  };
}

export function TaskWorkspace({
  activeView, createRequest, now = new Date(), searchTarget, onSearchTargetConsumed,
  launchTaskId, onLaunchTaskConsumed,
}: TaskWorkspaceProps) {
  const { currentMemberId, repository, snapshot } = useWorkspace();
  const [quickOpen, setQuickOpen] = useState(false);
  const [acknowledgedCreateRequest, setAcknowledgedCreateRequest] = useState(createRequest);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickError, setQuickError] = useState('');
  const quickInput = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const detailOriginRef = useRef<HTMLButtonElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [draftError, setDraftError] = useState('');
  const [draftRefreshing, setDraftRefreshing] = useState(false);
  const saveInFlightRef = useRef(false);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const [priorityFilters, setPriorityFilters] = useState<Priority[]>([]);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [taskViewState, setTaskViewState] = useState<TaskViewState>(() => ({
    source: activeView,
    value: activeView === 'today' ? 'today' : 'all',
  }));
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [deadlineFilter, setDeadlineFilter] = useState<'all' | TaskDeadlineFilter>('all');
  const [sectionFilter, setSectionFilter] = useState('all');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const tasksRef = useRef(snapshot.tasks);
  useEffect(() => { tasksRef.current = snapshot.tasks; }, [snapshot.tasks]);

  if (taskViewState.source !== activeView) {
    setTaskViewState({ source: activeView, value: activeView === 'today' ? 'today' : 'all' });
  }
  const taskView = taskViewState.source === activeView
    ? taskViewState.value
    : activeView === 'today' ? 'today' : 'all';

  const quickVisible = quickOpen || createRequest > acknowledgedCreateRequest;

  useEffect(() => {
    if (quickVisible) quickInput.current?.focus();
  }, [quickVisible]);

  const selectedTask = snapshot.tasks.find((task) => task.id === selectedId) ?? null;
  const tasks = useMemo(() => {
    const filter: TaskFilter = {
      priorities: priorityFilters.length ? priorityFilters : undefined,
      statusIds: statusFilters.length ? statusFilters : undefined,
      assigneeIds: assigneeFilter !== 'all' && assigneeFilter !== 'unassigned' ? [assigneeFilter] : undefined,
      unassignedOnly: assigneeFilter === 'unassigned' || undefined,
      sectionIds: sectionFilter !== 'all' ? [sectionFilter] : undefined,
      deadline: deadlineFilter !== 'all' ? deadlineFilter : undefined,
      now,
      includeCompleted,
    };
    const visible = snapshot.tasks.filter((task) => matchesTaskFilter(task, filter, snapshot.taskStatuses));
    if (taskView === 'my') return currentMemberId ? visible.filter((task) => task.assigneeId === currentMemberId) : [];
    if (taskView === 'overdue') return visible.filter((task) => task.dueAt && moscowDateKey(new Date(task.dueAt)) < moscowDateKey(now));
    if (taskView === 'unassigned') return visible.filter((task) => task.assigneeId === null);
    return taskView === 'today' ? orderTodayTasks(visible, now) : visible;
  }, [assigneeFilter, currentMemberId, deadlineFilter, includeCompleted, now, priorityFilters, sectionFilter, snapshot.taskStatuses, snapshot.tasks, statusFilters, taskView]);
  const todayGroups = useMemo(() => groupTodayTasks(tasks, now), [now, tasks]);

  const openTask = (task: Task, origin?: HTMLButtonElement) => {
    if (origin) detailOriginRef.current = origin;
    setSelectedId(task.id);
    setDraft(draftFrom(task));
    setDraftVersion(task.version);
    setConflictVersion(null);
    setDraftError('');
  };

  useEffect(() => {
    if (selectedId) detailRef.current?.focus();
  }, [selectedId]);

  const closeTask = () => {
    setSelectedId(null);
    window.setTimeout(() => detailOriginRef.current?.focus(), 0);
  };
  useTelegramBackButton(selectedTask !== null, closeTask);

  useEffect(() => {
    if (!searchTarget) return;
    const timer = window.setTimeout(() => {
      const task = tasksRef.current.find((item) => item.id === searchTarget.id);
      if (task) openTask(task);
      onSearchTargetConsumed?.(searchTarget.requestKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onSearchTargetConsumed, searchTarget]);

  useEffect(() => {
    if (!launchTaskId) return;
    const timer = window.setTimeout(() => {
      const task = tasksRef.current.find((item) => item.id === launchTaskId);
      if (task) openTask(task);
      onLaunchTaskConsumed?.();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [launchTaskId, onLaunchTaskConsumed]);

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await repository.createTask({ title: quickTitle });
      setQuickTitle('');
      setQuickError('');
      setQuickOpen(false);
      setAcknowledgedCreateRequest(createRequest);
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : 'Не удалось создать задачу.');
    }
  };

  const saveDraft = async (version = draftVersion) => {
    if (!selectedId || !draft || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      const updated = await repository.updateTask(selectedId, draft, version);
      setDraft(draftFrom(updated));
      setDraftVersion(updated.version);
      setConflictVersion(null);
      setDraftError('');
    } catch (error) {
      if (error instanceof ConflictError) {
        setConflictVersion(error.actualVersion);
        return;
      }
      setDraftError(error instanceof Error ? error.message : 'Не удалось сохранить задачу.');
    } finally {
      saveInFlightRef.current = false;
    }
  };

  const reloadDraft = async () => {
    if (!selectedId || draftRefreshing) return;
    setDraftRefreshing(true);
    setDraftError('');
    try {
      const refreshed = await repository.refresh();
      const current = refreshed.tasks.find((task) => task.id === selectedId);
      if (!current) throw new Error('Актуальная версия задачи не найдена.');
      setDraft(draftFrom(current));
      setDraftVersion(current.version);
      setConflictVersion(null);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'Не удалось загрузить актуальную версию.');
    } finally {
      setDraftRefreshing(false);
    }
  };

  const addComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !comment.trim()) return;
    const author = snapshot.members.find((member) => member.id === currentMemberId && member.active)
      ?? snapshot.members.find((member) => member.active);
    if (!author) return;
    try {
      await repository.createComment({ taskId: selectedId, authorId: author.id, body: comment });
      setComment('');
      setCommentError('');
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : 'Не удалось добавить комментарий.');
    }
  };

  const togglePriority = (priority: Priority) => setPriorityFilters((current) =>
    current.includes(priority) ? current.filter((value) => value !== priority) : [...current, priority],
  );
  const toggleStatus = (statusId: string) => setStatusFilters((current) =>
    current.includes(statusId) ? current.filter((value) => value !== statusId) : [...current, statusId],
  );

  const deleteTask = async () => {
    if (!selectedId) return;
    try {
      await repository.deleteTask(selectedId, draftVersion);
      closeTask();
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'Не удалось удалить задачу.');
    }
  };

  const taskCard = (task: Task) => {
    const status = snapshot.taskStatuses.find((candidate) => candidate.id === task.statusId);
    return (
      <button aria-label={`Открыть задачу ${task.title}`} className="task-card" key={task.id} onClick={(event) => openTask(task, event.currentTarget)} type="button">
        <span className={`priority priority--${task.priority}`}>P{task.priority}</span>
        <span className="task-card__body"><strong>{task.title}</strong><small>{status?.name ?? 'Без статуса'}</small></span>
        {task.dueAt && <time dateTime={task.dueAt}>{formatMoscowDateTime(task.dueAt)}</time>}
      </button>
    );
  };

  return (
    <section className={`tasks-workspace ${selectedTask ? 'tasks-workspace--detail' : ''}`}>
      <div className="tasks-workspace__list">
        <header className="tasks-header">
          <div>
            <p className="workspace-loading__eyebrow">Smoking Zen</p>
            <h1>{activeView === 'today' ? 'Сегодня' : 'Задачи'}</h1>
          </div>
          <button className="task-secondary-button" onClick={() => setQuickOpen(true)} type="button">Быстрая задача</button>
        </header>

        {quickVisible && (
          <form aria-label="Быстрое создание задачи" className="quick-task" onSubmit={createTask}>
            <label htmlFor="quick-task-title">Название задачи</label>
            <div className="quick-task__row">
              <input id="quick-task-title" onChange={(event) => setQuickTitle(event.target.value)} ref={quickInput} value={quickTitle} />
              <button type="submit">Добавить</button>
              <button onClick={() => { setQuickOpen(false); setAcknowledgedCreateRequest(createRequest); }} type="button">Отмена</button>
            </div>
            {quickError && <p role="alert">{quickError}</p>}
            <p className="task-hint">Статус Новая · приоритет P3</p>
          </form>
        )}

        <div aria-label="Представление задач" className="task-views" role="group">
          {([
            ['my', 'Мои'], ['today', 'Сегодня'], ['overdue', 'Просрочено'], ['unassigned', 'Без исполнителя'], ['all', 'Все'],
          ] as const).map(([view, label]) => (
            <button
              aria-pressed={taskView === view}
              key={view}
              onClick={() => setTaskViewState({ source: activeView, value: view })}
              type="button"
            >{label}</button>
          ))}
        </div>

        <button
          aria-controls="task-filters"
          aria-expanded={filtersExpanded}
          aria-label="Фильтры задач"
          className="task-filters-toggle task-secondary-button"
          onClick={() => setFiltersExpanded((current) => !current)}
          type="button"
        >Фильтры</button>
        <div aria-label="Фильтры задач" className="task-filters" data-expanded={filtersExpanded} id="task-filters">
          <label>Фильтр: исполнитель
            <select aria-label="Фильтр по исполнителю" onChange={(event) => setAssigneeFilter(event.target.value)} value={assigneeFilter}>
              <option value="all">Все</option><option value="unassigned">Без исполнителя</option>
              {snapshot.members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label>Фильтр: срок
            <select aria-label="Фильтр по сроку" onChange={(event) => setDeadlineFilter(event.target.value as 'all' | TaskDeadlineFilter)} value={deadlineFilter}>
              <option value="all">Любой</option><option value="today">Сегодня</option><option value="overdue">Просрочено</option><option value="no-deadline">Без срока</option>
            </select>
          </label>
          <label>Фильтр: раздел
            <select aria-label="Фильтр по разделу" onChange={(event) => setSectionFilter(event.target.value)} value={sectionFilter}>
              <option value="all">Все</option>{snapshot.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
            </select>
          </label>
          {PRIORITIES.map((priority) => (
            <button aria-pressed={priorityFilters.includes(priority)} key={priority} onClick={() => togglePriority(priority)} type="button">P{priority}</button>
          ))}
          {snapshot.taskStatuses.map((status) => (
            <button aria-pressed={statusFilters.includes(status.id)} key={status.id} onClick={() => toggleStatus(status.id)} type="button">{status.name}</button>
          ))}
          <label className="task-filters__completed"><input checked={includeCompleted} onChange={(event) => setIncludeCompleted(event.target.checked)} type="checkbox" />Показывать завершённые</label>
        </div>

        {taskView === 'today' ? <div className="today-groups">
          {todayGroups.map((group) => <section aria-labelledby={`today-group-${group.key}`} className="today-group" key={group.key}>
            <div className="today-group__heading"><h2 id={`today-group-${group.key}`}>{group.title}</h2><span>{group.tasks.length}</span></div>
            <div className="task-list">{group.tasks.map(taskCard)}{!group.tasks.length && <p className="task-empty">Сейчас пусто.</p>}</div>
          </section>)}
        </div> : <div className="task-list">
          {tasks.map(taskCard)}
          {!tasks.length && <p className="task-empty">Задач по этим фильтрам нет.</p>}
        </div>}
      </div>

      {selectedTask && draft && (
        <aside
          aria-label="Детали задачи"
          className="task-detail"
          onKeyDown={(event) => { if (event.key === 'Escape') closeTask(); }}
          ref={detailRef}
          tabIndex={-1}
        >
          <button className="task-detail__close" onClick={closeTask} type="button">Закрыть</button>
          <label>Название<input onChange={(event) => setDraft({ ...draft, title: event.target.value })} value={draft.title} /></label>
          <label>Описание<textarea onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={5} value={draft.description} /></label>
          <div aria-label="Предпросмотр описания" className="task-preview" role="region"><SafeMarkdown value={draft.description} /></div>
          <div className="task-detail__grid">
            <label>Приоритет<select onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) as Priority })} value={draft.priority}>{PRIORITIES.map((priority) => <option key={priority} value={priority}>P{priority}</option>)}</select></label>
            <label>Статус<select onChange={(event) => setDraft({ ...draft, statusId: event.target.value })} value={draft.statusId}>{snapshot.taskStatuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
            <label>Исполнитель<select onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value || null })} value={draft.assigneeId ?? ''}><option value="">Не назначен</option>{snapshot.members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            <label>Раздел<select onChange={(event) => setDraft({ ...draft, sectionId: event.target.value || null })} value={draft.sectionId ?? ''}><option value="">Без раздела</option>{snapshot.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>
            <label>Срок<input onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? fromMoscowDateTimeLocal(event.target.value) : null })} type="datetime-local" value={draft.dueAt ? toMoscowDateTimeLocal(draft.dueAt) : ''} /></label>
          </div>
          <button className="task-primary-button" onClick={() => saveDraft()} type="button">Сохранить задачу</button>
          <button className="task-secondary-button task-delete-button" onClick={() => void deleteTask()} type="button">Удалить задачу</button>
          {draftError && <p className="task-validation-error" role="alert">{draftError}</p>}
          {conflictVersion !== null && (
            <div className="task-conflict" role="alert">
              <p>Задача изменена другим пользователем. Ваши данные сохранены в форме.</p>
              <button disabled={draftRefreshing} onClick={() => void reloadDraft()} type="button">
                {draftRefreshing ? 'Загружаем актуальную версию…' : 'Загрузить актуальную версию'}
              </button>
              <button disabled={draftRefreshing} onClick={() => void saveDraft(conflictVersion)} type="button">Повторить с моими данными</button>
            </div>
          )}
          <AttachmentWidget attachments={selectedTask.attachments} target={{ type: 'task', id: selectedTask.id }} />
          <AuditHistory defaultOpen entity="task" entityId={selectedTask.id} events={snapshot.auditEvents} />
          <section className="task-comments">
            <h2>Комментарии</h2>
            {snapshot.comments.filter((item) => item.taskId === selectedId).map((item) => <p key={item.id}>{item.body}</p>)}
            <form onSubmit={addComment}>
              <label>Новый комментарий<textarea onChange={(event) => setComment(event.target.value)} value={comment} /></label>
              <button type="submit">Добавить комментарий</button>
              {commentError && <p role="alert">{commentError}</p>}
            </form>
          </section>
        </aside>
      )}
    </section>
  );
}
