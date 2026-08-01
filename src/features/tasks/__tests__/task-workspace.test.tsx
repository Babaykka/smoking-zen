import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { demoSeed } from '@/data/demo-seed';
import { ConflictError, type WorkspaceRepository } from '@/data/workspace-repository';
import type { Task } from '@/domain/types';
import { TaskWorkspace } from '@/features/tasks/task-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

afterEach(() => window.localStorage.clear());

function renderWorkspace(repository: WorkspaceRepository, props: Partial<React.ComponentProps<typeof TaskWorkspace>> = {}) {
  return render(
    <WorkspaceProvider repository={repository}>
      <TaskWorkspace activeView="tasks" createRequest={0} {...props} />
    </WorkspaceProvider>,
  );
}

describe('TaskWorkspace', () => {
  it('creates a task from only a title with P3 and rejects an empty title', () => {
    const repository = createDemoRepository({ seed: { ...demoSeed, tasks: [] }, loadPersisted: false });
    const { rerender } = renderWorkspace(repository);

    fireEvent.click(screen.getByRole('button', { name: 'Быстрая задача' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Быстрое создание задачи' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Введите название задачи.');

    fireEvent.change(screen.getByLabelText('Название задачи'), { target: { value: 'Заказать мяту' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Быстрое создание задачи' }));

    expect(screen.getByText('Заказать мяту')).toBeInTheDocument();
    expect(repository.snapshot().tasks[0]).toMatchObject({ title: 'Заказать мяту', priority: 3, assigneeId: null, dueAt: null });

    rerender(
      <WorkspaceProvider repository={repository}>
        <TaskWorkspace activeView="tasks" createRequest={1} />
      </WorkspaceProvider>,
    );
    expect(screen.getByLabelText('Название задачи')).toHaveFocus();
  });

  it('does not persist secret-like text from fast creation', () => {
    const repository = createDemoRepository({ seed: { ...demoSeed, tasks: [] }, loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: 'Быстрая задача' }));
    fireEvent.change(screen.getByLabelText('Название задачи'), { target: { value: 'password: hunter2' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Быстрое создание задачи' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Секретные данные');
    expect(repository.snapshot().tasks).toEqual([]);
  });

  it('shows Today priorities in overdue, today, urgent unassigned, then recent activity order', () => {
    const workspaceId = demoSeed.workspaceId;
    const base = demoSeed.tasks[0]!;
    const repository = createDemoRepository({
      loadPersisted: false,
      seed: {
        ...demoSeed,
        tasks: ([
          { ...base, id: 'recent', title: 'Недавняя', dueAt: null, priority: 4, assigneeId: 'member-alina', updatedAt: '2026-08-02T11:00:00.000Z' },
          { ...base, id: 'urgent', title: 'Срочная без исполнителя', dueAt: null, priority: 1, assigneeId: null, updatedAt: '2026-08-01T08:00:00.000Z' },
          { ...base, id: 'today', title: 'На сегодня', dueAt: '2026-08-02T18:00:00.000Z', priority: 5, updatedAt: '2026-08-01T07:00:00.000Z' },
          { ...base, id: 'overdue', title: 'Просроченная', dueAt: '2026-08-01T18:00:00.000Z', priority: 5, updatedAt: '2026-07-31T07:00:00.000Z' },
        ] satisfies Task[]).map((task) => ({ ...task, workspaceId })),
      },
    });

    renderWorkspace(repository, { activeView: 'today', now: new Date('2026-08-02T12:00:00.000Z') });

    expect(screen.getAllByRole('button', { name: /Открыть задачу/ }).map((button) => button.textContent)).toEqual([
      expect.stringContaining('Просроченная'),
      expect.stringContaining('На сегодня'),
      expect.stringContaining('Срочная без исполнителя'),
      expect.stringContaining('Недавняя'),
    ]);
  });

  it('filters tasks by exact priority and status chips', () => {
    const base = demoSeed.tasks[0]!;
    const repository = createDemoRepository({
      loadPersisted: false,
      seed: {
        ...demoSeed,
        tasks: [
          { ...base, id: 'p1', title: 'Высокая', priority: 1 },
          { ...base, id: 'p3', title: 'Обычная', priority: 3, statusId: 'status-in-progress' },
        ],
      },
    });
    renderWorkspace(repository);

    fireEvent.click(screen.getByRole('button', { name: 'P1' }));
    expect(screen.getByText('Высокая')).toBeInTheDocument();
    expect(screen.queryByText('Обычная')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'P1' }));
    fireEvent.click(screen.getByRole('button', { name: 'В работе' }));
    expect(screen.getByText('Обычная')).toBeInTheDocument();
    expect(screen.queryByText('Высокая')).not.toBeInTheDocument();
  });

  it('edits one assignee, optional deadline, priority, status, and sanitized Markdown checklist', () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));

    fireEvent.change(screen.getByLabelText('Описание'), { target: { value: '- [x] Проверено\n<script>alert(1)</script> **важно**' } });
    fireEvent.change(screen.getByLabelText('Приоритет'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Статус'), { target: { value: 'status-in-progress' } });
    fireEvent.change(screen.getByLabelText('Исполнитель'), { target: { value: 'member-owner' } });
    fireEvent.change(screen.getByLabelText('Срок'), { target: { value: '2026-08-05T15:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    expect(repository.snapshot().tasks[0]).toMatchObject({ priority: 1, statusId: 'status-in-progress', assigneeId: 'member-owner' });
    expect(repository.snapshot().tasks[0]?.dueAt).toContain('2026-08-05T15:30');
    const preview = screen.getByRole('region', { name: 'Предпросмотр описания' });
    expect(within(preview).getByRole('checkbox')).toBeChecked();
    expect(preview).toHaveTextContent('<script>alert(1)</script> важно');
    expect(preview.querySelector('script')).toBeNull();
  });

  it('adds comments to the selected task', () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Новый комментарий'), { target: { value: 'Поставщик подтвердил' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить комментарий' }));

    expect(screen.getByText('Поставщик подтвердил')).toBeInTheDocument();
    expect(repository.snapshot().comments[0]).toMatchObject({ taskId: 'task-check-coals', authorId: 'member-owner' });
  });

  it('preserves the draft on a version conflict and offers reload or retry', () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const originalUpdate = repository.updateTask.bind(repository);
    repository.updateTask = vi.fn(() => { throw new ConflictError(1, 2); });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задача|Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Мой несохранённый текст' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    expect(screen.getByRole('alert')).toHaveTextContent('изменена другим пользователем');
    expect(screen.getByLabelText('Название')).toHaveValue('Мой несохранённый текст');
    expect(screen.getByRole('button', { name: 'Загрузить актуальную версию' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить с моими данными' })).toBeInTheDocument();

    repository.updateTask = originalUpdate;
  });
});
