import { describe, expect, it } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { ConflictError, type WorkspacePersistence } from '@/data/workspace-repository';

function createMemoryPersistence(): WorkspacePersistence {
  let value: unknown = null;

  return {
    load: () => value,
    save: (snapshot) => {
      value = structuredClone(snapshot);
    },
  };
}

function createRepository() {
  let nextId = 1;
  return createDemoRepository({
    clock: () => '2026-08-02T10:00:00.000Z',
    idFactory: () => `test-${nextId++}`,
    persistence: createMemoryPersistence(),
  });
}

describe('demo workspace repository', () => {
  it('exposes a visible deterministic seed without sharing mutable snapshots', () => {
    const repository = createRepository();
    const firstSnapshot = repository.snapshot();

    expect(firstSnapshot.tasks).not.toHaveLength(0);
    expect(firstSnapshot.taskStatuses.map((status) => status.name)).toEqual([
      'Новая',
      'В работе',
      'Ждёт',
      'Готово',
    ]);

    firstSnapshot.tasks[0]!.title = 'tampered';
    expect(repository.snapshot().tasks[0]!.title).not.toBe('tampered');
  });

  it('increments a task version once and preserves state after a stale update', () => {
    const repository = createRepository();
    const created = repository.createTask({ title: 'Проверить вытяжку' });
    const updated = repository.updateTask(created.id, { title: 'Проверить вытяжку вечером' }, created.version);

    expect(updated.version).toBe(2);
    expect(() => repository.updateTask(created.id, { title: 'Неверная запись' }, created.version)).toThrow(
      ConflictError,
    );
    expect(repository.snapshot().tasks.find((task) => task.id === created.id)).toMatchObject({
      title: 'Проверить вытяжку вечером',
      version: 2,
    });
  });

  it('removes deleted tasks from snapshots and search until restored', () => {
    const repository = createRepository();
    const created = repository.createTask({ title: 'Проверить кальяны' });
    const deleted = repository.deleteTask(created.id, created.version);

    expect(repository.snapshot().tasks.some((task) => task.id === created.id)).toBe(false);
    expect(repository.search('кальяны')).not.toContainEqual({ entity: 'task', id: created.id, title: 'Проверить кальяны' });

    const restored = repository.restore('task', created.id, deleted.version);
    expect(restored).toMatchObject({ id: created.id, deletedAt: null, version: 3 });
    expect(repository.snapshot().tasks.some((task) => task.id === created.id)).toBe(true);
  });

  it('never searches secure URLs or metadata', () => {
    const repository = createRepository();
    repository.createSecureItem({
      title: 'Касса',
      externalUrl: 'https://vault.bitwarden.com/#/items/very-private-url',
      metadata: { label: 'very-private-metadata' },
    });

    expect(repository.search('very-private')).toEqual([]);
  });

  it('notifies subscribers in mutation order with immutable snapshots', () => {
    const repository = createRepository();
    const received: string[][] = [];
    const unsubscribe = repository.subscribe((snapshot) => {
      received.push(snapshot.tasks.filter((task) => task.id.startsWith('test-')).map((task) => task.title));
      snapshot.tasks.forEach((task) => {
        task.title = 'cannot persist';
      });
    });

    const task = repository.createTask({ title: 'Открыть смену' });
    repository.updateTask(task.id, { title: 'Закрыть смену' }, task.version);
    unsubscribe();

    expect(received).toEqual([['Открыть смену'], ['Закрыть смену']]);
    expect(repository.snapshot().tasks.find((item) => item.id === task.id)?.title).toBe('Закрыть смену');
  });
});
