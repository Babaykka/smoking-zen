import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { demoSeed } from '@/data/demo-seed';
import { ConflictError, type WorkspaceRepository } from '@/data/workspace-repository';
import type { Task } from '@/domain/types';
import { groupTodayTasks, TaskWorkspace } from '@/features/tasks/task-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

afterEach(() => window.localStorage.clear());

function renderWorkspace(repository: WorkspaceRepository, props: Partial<React.ComponentProps<typeof TaskWorkspace>> = {}, currentMemberId = 'member-owner') {
  return render(
    <WorkspaceProvider currentMemberId={currentMemberId} gateway={createDemoGateway(repository)}>
      <TaskWorkspace activeView="tasks" createRequest={0} {...props} />
    </WorkspaceProvider>,
  );
}

describe('TaskWorkspace', () => {
  it('keeps advanced filters behind an explicit mobile disclosure while preserving desktop controls', () => {
    renderWorkspace(createDemoRepository({ loadPersisted: false }));
    const toggle = screen.getByRole('button', { name: 'Фильтры задач' });
    const filters = document.getElementById('task-filters');
    expect(filters).not.toBeNull();

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(filters!).toHaveAttribute('data-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(filters!).toHaveAttribute('data-expanded', 'true');
  });
  it('creates a task from only a title with P3 and rejects an empty title', async () => {
    const repository = createDemoRepository({ seed: { ...demoSeed, tasks: [] }, loadPersisted: false });
    const { rerender } = renderWorkspace(repository);

    fireEvent.click(screen.getByRole('button', { name: 'Быстрая задача' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Быстрое создание задачи' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Введите название задачи\.$/);

    fireEvent.change(screen.getByLabelText('Название задачи'), { target: { value: 'Заказать мяту' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Быстрое создание задачи' }));

    expect(await screen.findByText('Заказать мяту')).toBeInTheDocument();
    expect(repository.snapshot().tasks[0]).toMatchObject({ title: 'Заказать мяту', priority: 3, assigneeId: null, dueAt: null });

    rerender(
      <WorkspaceProvider gateway={createDemoGateway(repository)}>
        <TaskWorkspace activeView="tasks" createRequest={1} />
      </WorkspaceProvider>,
    );
    expect(screen.getByLabelText('Название задачи')).toHaveFocus();
  });

  it('does not persist secret-like text from fast creation', async () => {
    const repository = createDemoRepository({ seed: { ...demoSeed, tasks: [] }, loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: 'Быстрая задача' }));
    fireEvent.change(screen.getByLabelText('Название задачи'), { target: { value: 'password: hunter2' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Быстрое создание задачи' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Секретные данные');
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
    expect(screen.getByRole('heading', { name: 'Просрочено' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'На сегодня' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'P1/P2 без исполнителя' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Последние изменения' })).toBeInTheDocument();
  });

  it('keeps only the five newest ordinary tasks in Today recent activity', () => {
    const base = demoSeed.tasks[0]!;
    const recent = Array.from({ length: 8 }, (_, index) => ({
      ...base,
      id: `recent-${index}`,
      title: `Недавняя ${index}`,
      priority: 4 as const,
      assigneeId: 'member-owner',
      dueAt: null,
      updatedAt: `2026-08-02T${String(index + 1).padStart(2, '0')}:00:00.000Z`,
    }));

    const groups = groupTodayTasks(recent, new Date('2026-08-02T12:00:00.000Z'));

    expect(groups.find((group) => group.key === 'recent')?.tasks.map((task) => task.id)).toEqual([
      'recent-7', 'recent-6', 'recent-5', 'recent-4', 'recent-3',
    ]);
    expect(groups.slice(0, 3).every((group) => group.tasks.length === 0)).toBe(true);
  });

  it('provides the exact task views and resolves “Мои” from authenticated member context', () => {
    const base = demoSeed.tasks[0]!;
    const repository = createDemoRepository({
      loadPersisted: false,
      seed: {
        ...demoSeed,
        tasks: [
          { ...base, id: 'mine', title: 'Моя задача', assigneeId: 'member-alina', dueAt: null },
          { ...base, id: 'other', title: 'Чужая задача', assigneeId: 'member-owner', dueAt: null },
          { ...base, id: 'unassigned', title: 'Без исполнителя', assigneeId: null, dueAt: null },
          { ...base, id: 'overdue-view', title: 'Просроченная для вида', assigneeId: null, dueAt: '2026-08-01T10:00:00.000Z' },
        ],
      },
    });
    renderWorkspace(repository, { now: new Date('2026-08-02T12:00:00.000Z') }, 'member-alina');

    for (const name of ['Мои', 'Сегодня', 'Просрочено', 'Без исполнителя', 'Все']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Мои' }));
    expect(screen.getByText('Моя задача')).toBeInTheDocument();
    expect(screen.queryByText('Чужая задача')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Без исполнителя' }));
    expect(screen.getByRole('button', { name: 'Открыть задачу Без исполнителя' })).toBeInTheDocument();
    expect(screen.getByText('Просроченная для вида')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Просрочено' }));
    expect(screen.getByText('Просроченная для вида')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Открыть задачу Без исполнителя' })).not.toBeInTheDocument();
  });

  it('combines assignee, status, priority, deadline, and section filters and can reveal completed tasks', () => {
    const base = demoSeed.tasks[0]!;
    const repository = createDemoRepository({
      loadPersisted: false,
      seed: {
        ...demoSeed,
        tasks: [
          { ...base, id: 'match', title: 'Полное совпадение', priority: 2, assigneeId: null, sectionId: 'section-service', statusId: 'status-in-progress', dueAt: null },
          { ...base, id: 'done', title: 'Завершённая', priority: 2, assigneeId: null, sectionId: 'section-service', statusId: 'status-done', dueAt: null },
          { ...base, id: 'wrong', title: 'Не совпадает', priority: 1, assigneeId: 'member-owner', sectionId: 'section-stock', statusId: 'status-new', dueAt: '2026-08-02T10:00:00.000Z' },
        ],
      },
    });
    renderWorkspace(repository);

    fireEvent.change(screen.getByLabelText('Фильтр по исполнителю'), { target: { value: 'unassigned' } });
    fireEvent.change(screen.getByLabelText('Фильтр по сроку'), { target: { value: 'no-deadline' } });
    fireEvent.change(screen.getByLabelText('Фильтр по разделу'), { target: { value: 'section-service' } });
    fireEvent.click(screen.getByRole('button', { name: 'P2' }));
    fireEvent.click(screen.getByRole('button', { name: 'В работе' }));

    expect(screen.getByText('Полное совпадение')).toBeInTheDocument();
    expect(screen.queryByText('Не совпадает')).not.toBeInTheDocument();
    expect(screen.queryByText('Завершённая')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Показывать завершённые' }));
    fireEvent.click(screen.getByRole('button', { name: 'В работе' }));
    expect(screen.getByText('Завершённая')).toBeInTheDocument();
  });

  it('soft-deletes a task and exposes its immutable history', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));

    expect(screen.getByRole('heading', { name: 'История' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить задачу' }));

    await waitFor(() => expect(screen.queryByText('Проверить запас кокосового угля')).not.toBeInTheDocument());
    expect(repository.search('кокосового')).toEqual([]);
  });

  it('applies an explicit conflict retry once while preserving every draft field', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const originalUpdate = repository.updateTask.bind(repository);
    let first = true;
    repository.updateTask = vi.fn((id, input, version) => {
      if (first) {
        first = false;
        originalUpdate(id, { title: 'Изменено на другом устройстве' }, version);
        throw new ConflictError(version, version + 1);
      }
      return originalUpdate(id, input, version);
    });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Мой полный черновик' } });
    fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Все поля остаются' } });
    fireEvent.change(screen.getByLabelText('Приоритет'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    expect(await screen.findByText(/Ваши данные сохранены/)).toBeInTheDocument();
    expect(screen.getByLabelText('Название')).toHaveValue('Мой полный черновик');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить с моими данными' }));

    await waitFor(() => expect(repository.snapshot().tasks[0]).toMatchObject({
      title: 'Мой полный черновик', description: 'Все поля остаются', priority: 5, version: 3,
    }));
    expect(repository.updateTask).toHaveBeenCalledTimes(2);
  });

  it('loads an explicitly refreshed server task after a conflict without losing the local draft first', async () => {
    const localRepository = createDemoRepository({ loadPersisted: false });
    const original = localRepository.snapshot().tasks[0]!;
    const remoteTask: Task = {
      ...original,
      title: 'Актуальная серверная версия',
      description: 'Ответ с сервера',
      priority: 2,
      statusId: 'status-in-progress',
      sectionId: 'section-service',
      assigneeId: 'member-alina',
      dueAt: '2026-08-06T10:00:00.000Z',
      version: 2,
    };
    const gateway = {
      ...createDemoGateway(localRepository),
      updateTask: vi.fn().mockRejectedValue(new ConflictError(1, 2)),
      refresh: vi.fn().mockResolvedValue({ ...localRepository.snapshot(), tasks: [remoteTask] }),
    };
    render(
      <WorkspaceProvider gateway={gateway}>
        <TaskWorkspace activeView="tasks" createRequest={0} />
      </WorkspaceProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Мой локальный заголовок' } });
    fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Моё локальное описание' } });
    fireEvent.change(screen.getByLabelText('Приоритет'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Статус'), { target: { value: 'status-waiting' } });
    fireEvent.change(screen.getByLabelText('Исполнитель'), { target: { value: 'member-owner' } });
    fireEvent.change(screen.getByLabelText('Раздел'), { target: { value: 'section-stock' } });
    fireEvent.change(screen.getByLabelText('Срок'), { target: { value: '2026-08-05T15:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    expect(await screen.findByText(/Ваши данные сохранены/)).toBeInTheDocument();
    expect(screen.getByLabelText('Название')).toHaveValue('Мой локальный заголовок');
    expect(screen.getByLabelText('Описание')).toHaveValue('Моё локальное описание');
    expect(screen.getByLabelText('Приоритет')).toHaveValue('5');
    expect(screen.getByLabelText('Статус')).toHaveValue('status-waiting');
    expect(screen.getByLabelText('Исполнитель')).toHaveValue('member-owner');
    expect(screen.getByLabelText('Раздел')).toHaveValue('section-stock');
    expect(screen.getByLabelText('Срок')).toHaveValue('2026-08-05T15:30');

    fireEvent.click(screen.getByRole('button', { name: 'Загрузить актуальную версию' }));
    await waitFor(() => expect(gateway.refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByLabelText('Название')).toHaveValue('Актуальная серверная версия'));
    expect(screen.getByLabelText('Описание')).toHaveValue('Ответ с сервера');
    expect(screen.getByLabelText('Приоритет')).toHaveValue('2');
    expect(screen.getByLabelText('Статус')).toHaveValue('status-in-progress');
    expect(screen.getByLabelText('Исполнитель')).toHaveValue('member-alina');
    expect(screen.getByLabelText('Раздел')).toHaveValue('section-service');
    expect(screen.getByLabelText('Срок')).toHaveValue('2026-08-06T13:00');
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

  it('edits one assignee, optional deadline, priority, status, and sanitized Markdown checklist', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));

    fireEvent.change(screen.getByLabelText('Описание'), { target: { value: '- [x] Проверено\n<script>alert(1)</script> **важно**' } });
    fireEvent.change(screen.getByLabelText('Приоритет'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Статус'), { target: { value: 'status-in-progress' } });
    fireEvent.change(screen.getByLabelText('Исполнитель'), { target: { value: 'member-owner' } });
    fireEvent.change(screen.getByLabelText('Срок'), { target: { value: '2026-08-05T15:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    await waitFor(() => expect(repository.snapshot().tasks[0]).toMatchObject({ priority: 1, statusId: 'status-in-progress', assigneeId: 'member-owner' }));
    expect(repository.snapshot().tasks[0]?.dueAt).toBe('2026-08-05T12:30:00.000Z');
    expect(screen.getByLabelText('Срок')).toHaveValue('2026-08-05T15:30');
    const preview = screen.getByRole('region', { name: 'Предпросмотр описания' });
    expect(within(preview).getByRole('checkbox')).toBeChecked();
    expect(preview).toHaveTextContent('<script>alert(1)</script> важно');
    expect(preview.querySelector('script')).toBeNull();
  });

  it('adds comments to the selected task', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Новый комментарий'), { target: { value: 'Поставщик подтвердил' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить комментарий' }));

    expect(await screen.findByText('Поставщик подтвердил')).toBeInTheDocument();
    expect(repository.snapshot().comments[0]).toMatchObject({ taskId: 'task-check-coals', authorId: 'member-owner' });
  });

  it('preserves the draft on a version conflict and offers reload or retry', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const originalUpdate = repository.updateTask.bind(repository);
    repository.updateTask = vi.fn(() => { throw new ConflictError(1, 2); });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задача|Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Мой несохранённый текст' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('изменена другим пользователем');
    expect(screen.getByLabelText('Название')).toHaveValue('Мой несохранённый текст');
    expect(screen.getByRole('button', { name: 'Загрузить актуальную версию' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить с моими данными' })).toBeInTheDocument();

    repository.updateTask = originalUpdate;
  });

  it('shows an accessible validation error and preserves a blank editor draft', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    fireEvent.click(screen.getByRole('button', { name: /Открыть задачу Проверить запас/ }));
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить задачу' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/^Введите название задачи\.$/);
    expect(screen.getByLabelText('Название')).toHaveValue('   ');
    expect(repository.snapshot().tasks[0]?.title).toBe('Проверить запас кокосового угля');
  });

  it('consumes keyed task navigation once, preserves drafts on refetch, and can reopen the same task', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const gateway = createDemoGateway(repository);
    const consumed = vi.fn();
    const rendered = render(
      <WorkspaceProvider gateway={gateway}>
        <TaskWorkspace activeView="tasks" createRequest={0} onSearchTargetConsumed={consumed} searchTarget={{ id: 'task-check-coals', requestKey: 1 }} />
      </WorkspaceProvider>,
    );
    expect(await screen.findByLabelText('Название')).toHaveValue('Проверить запас кокосового угля');
    expect(consumed).toHaveBeenCalledWith(1);
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Несохранённая задача' } });
    await gateway.createTask({ title: 'Событие Realtime' });
    expect(screen.getByLabelText('Название')).toHaveValue('Несохранённая задача');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    rendered.rerender(
      <WorkspaceProvider gateway={gateway}>
        <TaskWorkspace activeView="tasks" createRequest={0} onSearchTargetConsumed={consumed} searchTarget={{ id: 'task-check-coals', requestKey: 2 }} />
      </WorkspaceProvider>,
    );
    expect(await screen.findByLabelText('Название')).toHaveValue('Проверить запас кокосового угля');
    expect(consumed).toHaveBeenLastCalledWith(2);
  });

  it('moves focus into mobile details, closes on Escape, and restores the originating task card', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    renderWorkspace(repository);
    const opener = screen.getByRole('button', { name: /Открыть задачу Проверить запас/ });

    opener.focus();
    fireEvent.click(opener);

    const details = await screen.findByRole('complementary', { name: 'Детали задачи' });
    await waitFor(() => expect(details).toHaveFocus());
    fireEvent.keyDown(details, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Детали задачи' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
