'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { ConflictError } from '@/data/workspace-repository';
import { matchesTaskFilter, type TaskFilter } from '@/domain/filters';
import type { Priority, Task } from '@/domain/types';
import { useWorkspace } from '@/providers/workspace-provider';

export type TaskWorkspaceProps = {
  activeView: 'today' | 'tasks';
  createRequest: number;
  now?: Date;
};

type TaskDraft = Pick<Task, 'title' | 'description' | 'priority' | 'statusId' | 'sectionId' | 'assigneeId' | 'dueAt'>;

const PRIORITIES: Priority[] = [1, 2, 3, 4, 5];

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayRank(task: Task, now: Date): number {
  const today = dateKey(now);
  const due = task.dueAt?.slice(0, 10);
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

function inlineMarkdown(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <span key={index}>{part}</span>,
  );
}

export function SafeMarkdown({ value }: { value: string }) {
  return (
    <div className="task-markdown">
      {value.split('\n').map((line, index) => {
        const checklist = /^\s*- \[([ xX])\]\s+(.*)$/.exec(line);
        if (checklist) {
          return (
            <label className="task-markdown__check" key={index}>
              <input checked={checklist[1]?.toLowerCase() === 'x'} disabled readOnly type="checkbox" />
              <span>{inlineMarkdown(checklist[2] ?? '')}</span>
            </label>
          );
        }
        return <p key={index}>{inlineMarkdown(line)}</p>;
      })}
    </div>
  );
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

export function TaskWorkspace({ activeView, createRequest, now = new Date() }: TaskWorkspaceProps) {
  const { repository, snapshot } = useWorkspace();
  const [quickOpen, setQuickOpen] = useState(false);
  const [acknowledgedCreateRequest, setAcknowledgedCreateRequest] = useState(createRequest);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickError, setQuickError] = useState('');
  const quickInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [priorityFilters, setPriorityFilters] = useState<Priority[]>([]);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);

  const quickVisible = quickOpen || createRequest > acknowledgedCreateRequest;

  useEffect(() => {
    if (quickVisible) quickInput.current?.focus();
  }, [quickVisible]);

  const selectedTask = snapshot.tasks.find((task) => task.id === selectedId) ?? null;
  const tasks = useMemo(() => {
    const filter: TaskFilter = {
      priorities: priorityFilters.length ? priorityFilters : undefined,
      statusIds: statusFilters.length ? statusFilters : undefined,
    };
    const visible = snapshot.tasks.filter((task) => matchesTaskFilter(task, filter));
    return activeView === 'today' ? orderTodayTasks(visible, now) : visible;
  }, [activeView, now, priorityFilters, snapshot.tasks, statusFilters]);

  const openTask = (task: Task) => {
    setSelectedId(task.id);
    setDraft(draftFrom(task));
    setDraftVersion(task.version);
    setConflictVersion(null);
  };

  const createTask = (event: FormEvent) => {
    event.preventDefault();
    try {
      repository.createTask({ title: quickTitle });
      setQuickTitle('');
      setQuickError('');
      setQuickOpen(false);
      setAcknowledgedCreateRequest(createRequest);
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : 'Не удалось создать задачу.');
    }
  };

  const saveDraft = (version = draftVersion) => {
    if (!selectedId || !draft) return;
    try {
      const updated = repository.updateTask(selectedId, draft, version);
      setDraft(draftFrom(updated));
      setDraftVersion(updated.version);
      setConflictVersion(null);
    } catch (error) {
      if (error instanceof ConflictError) {
        setConflictVersion(error.actualVersion);
        return;
      }
      throw error;
    }
  };

  const reloadDraft = () => {
    const current = repository.snapshot().tasks.find((task) => task.id === selectedId);
    if (!current) return;
    setDraft(draftFrom(current));
    setDraftVersion(current.version);
    setConflictVersion(null);
  };

  const addComment = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !comment.trim()) return;
    const author = snapshot.members.find((member) => member.active);
    if (!author) return;
    repository.createComment({ taskId: selectedId, authorId: author.id, body: comment });
    setComment('');
  };

  const togglePriority = (priority: Priority) => setPriorityFilters((current) =>
    current.includes(priority) ? current.filter((value) => value !== priority) : [...current, priority],
  );
  const toggleStatus = (statusId: string) => setStatusFilters((current) =>
    current.includes(statusId) ? current.filter((value) => value !== statusId) : [...current, statusId],
  );

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

        <div aria-label="Фильтры задач" className="task-filters">
          {PRIORITIES.map((priority) => (
            <button aria-pressed={priorityFilters.includes(priority)} key={priority} onClick={() => togglePriority(priority)} type="button">P{priority}</button>
          ))}
          {snapshot.taskStatuses.map((status) => (
            <button aria-pressed={statusFilters.includes(status.id)} key={status.id} onClick={() => toggleStatus(status.id)} type="button">{status.name}</button>
          ))}
        </div>

        <div className="task-list">
          {tasks.map((task) => {
            const status = snapshot.taskStatuses.find((candidate) => candidate.id === task.statusId);
            return (
              <button aria-label={`Открыть задачу ${task.title}`} className="task-card" key={task.id} onClick={() => openTask(task)} type="button">
                <span className={`priority priority--${task.priority}`}>P{task.priority}</span>
                <span className="task-card__body"><strong>{task.title}</strong><small>{status?.name ?? 'Без статуса'}</small></span>
                {task.dueAt && <time dateTime={task.dueAt}>{task.dueAt.slice(0, 10)}</time>}
              </button>
            );
          })}
          {!tasks.length && <p className="task-empty">Задач по этим фильтрам нет.</p>}
        </div>
      </div>

      {selectedTask && draft && (
        <aside aria-label="Детали задачи" className="task-detail">
          <button className="task-detail__close" onClick={() => setSelectedId(null)} type="button">Закрыть</button>
          <label>Название<input onChange={(event) => setDraft({ ...draft, title: event.target.value })} value={draft.title} /></label>
          <label>Описание<textarea onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={5} value={draft.description} /></label>
          <div aria-label="Предпросмотр описания" className="task-preview" role="region"><SafeMarkdown value={draft.description} /></div>
          <div className="task-detail__grid">
            <label>Приоритет<select onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) as Priority })} value={draft.priority}>{PRIORITIES.map((priority) => <option key={priority} value={priority}>P{priority}</option>)}</select></label>
            <label>Статус<select onChange={(event) => setDraft({ ...draft, statusId: event.target.value })} value={draft.statusId}>{snapshot.taskStatuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
            <label>Исполнитель<select onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value || null })} value={draft.assigneeId ?? ''}><option value="">Не назначен</option>{snapshot.members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            <label>Раздел<select onChange={(event) => setDraft({ ...draft, sectionId: event.target.value || null })} value={draft.sectionId ?? ''}><option value="">Без раздела</option>{snapshot.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>
            <label>Срок<input onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? `${event.target.value}:00.000Z` : null })} type="datetime-local" value={draft.dueAt?.slice(0, 16) ?? ''} /></label>
          </div>
          <button className="task-primary-button" onClick={() => saveDraft()} type="button">Сохранить задачу</button>
          {conflictVersion !== null && (
            <div className="task-conflict" role="alert">
              <p>Задача изменена другим пользователем. Ваши данные сохранены в форме.</p>
              <button onClick={reloadDraft} type="button">Загрузить актуальную версию</button>
              <button onClick={() => saveDraft(conflictVersion)} type="button">Повторить с моими данными</button>
            </div>
          )}
          <section className="task-comments">
            <h2>Комментарии</h2>
            {snapshot.comments.filter((item) => item.taskId === selectedId).map((item) => <p key={item.id}>{item.body}</p>)}
            <form onSubmit={addComment}>
              <label>Новый комментарий<textarea onChange={(event) => setComment(event.target.value)} value={comment} /></label>
              <button type="submit">Добавить комментарий</button>
            </form>
          </section>
        </aside>
      )}
    </section>
  );
}
