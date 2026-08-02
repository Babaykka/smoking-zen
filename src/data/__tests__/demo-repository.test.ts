import { describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { demoSeed } from '@/data/demo-seed';
import {
  ConflictError,
  RestoreExpiredError,
  RestoreNotDeletedError,
  RestoreNotFoundError,
  type WorkspacePersistence,
} from '@/data/workspace-repository';
import type { NotificationDelivery, WorkspaceSnapshot } from '@/domain/types';

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

  it('restores a record just before the 30-day recovery deadline', () => {
    let now = '2026-08-01T10:00:00.000Z';
    const repository = createDemoRepository({
      clock: () => now,
      idFactory: (() => {
        let next = 1;
        return () => `deadline-${next++}`;
      })(),
      persistence: createMemoryPersistence(),
    });
    const created = repository.createTask({ title: 'Восстановить до срока' });
    const deleted = repository.deleteTask(created.id, created.version);
    now = '2026-08-31T09:59:59.999Z';

    expect(repository.restore('task', created.id, deleted.version)).toMatchObject({
      id: created.id,
      deletedAt: null,
    });
  });

  it('distinguishes missing and active records during restore without mutating state', () => {
    const repository = createRepository();
    const active = repository.snapshot().tasks[0]!;
    const before = repository.snapshot();

    expect(() => repository.restore('task', 'missing-task', 1)).toThrow(RestoreNotFoundError);
    expect(() => repository.restore('task', active.id, active.version)).toThrow(RestoreNotDeletedError);
    expect(repository.snapshot()).toEqual(before);
  });

  it('keeps optimistic-version precedence for a stale deleted record during restore', () => {
    const repository = createRepository();
    const created = repository.createTask({ title: 'Конфликт восстановления' });
    const deleted = repository.deleteTask(created.id, created.version);
    const before = repository.snapshot();

    expect(() => repository.restore('task', created.id, created.version)).toThrow(ConflictError);
    expect(repository.snapshot()).toEqual(before);
    expect(deleted.version).toBe(created.version + 1);
  });

  it('rejects restore exactly 30 days after deletion without mutating the deleted record', () => {
    let now = '2026-08-01T10:00:00.000Z';
    const repository = createDemoRepository({
      clock: () => now,
      idFactory: (() => {
        let next = 1;
        return () => `expired-${next++}`;
      })(),
      persistence: createMemoryPersistence(),
    });
    const created = repository.createTask({ title: 'Просроченное восстановление' });
    const deleted = repository.deleteTask(created.id, created.version);
    now = '2026-08-31T10:00:00.000Z';

    expect(() => repository.restore('task', created.id, deleted.version)).toThrow(RestoreExpiredError);
    expect(repository.snapshot().tasks.some((task) => task.id === created.id)).toBe(false);
  });

  it('generates distinct record and audit IDs after loading persisted state', () => {
    const persistence = createMemoryPersistence();
    const firstRepository = createDemoRepository({ persistence, clock: () => '2026-08-02T10:00:00.000Z' });
    const firstTask = firstRepository.createTask({ title: 'Первая запись' });
    const persistedIds = new Set([
      ...firstRepository.snapshot().tasks.map((task) => task.id),
      ...firstRepository.snapshot().auditEvents.map((event) => event.id),
    ]);
    const reloadedRepository = createDemoRepository({ persistence, clock: () => '2026-08-02T10:01:00.000Z' });
    const reloadedTask = reloadedRepository.createTask({ title: 'Запись после перезагрузки' });
    const reloadedAudit = reloadedRepository.snapshot().auditEvents.at(-1);

    expect(reloadedTask.id).not.toBe(firstTask.id);
    expect(persistedIds.has(reloadedTask.id)).toBe(false);
    expect(reloadedAudit).toBeDefined();
    expect(persistedIds.has(reloadedAudit!.id)).toBe(false);
  });

  it('defers persistence reads until hydration and keeps hydrated IDs unique', () => {
    const persisted = structuredClone(demoSeed);
    persisted.tasks.push({
      id: 'demo-1',
      workspaceId: persisted.workspaceId,
      title: 'Сохранённая задача',
      description: '',
      priority: 3,
      statusId: 'status-new',
      sectionId: null,
      assigneeId: null,
      dueAt: null,
      attachments: [],
      version: 1,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      deletedAt: null,
    });
    const load = vi.fn(() => persisted);
    const repository = createDemoRepository({ persistence: { load, save: () => {} }, loadPersisted: false });

    expect(load).not.toHaveBeenCalled();
    repository.hydrate();
    const created = repository.createTask({ title: 'Новая после гидратации' });

    expect(created.id).not.toBe('demo-1');
  });

  it('preserves mutable record metadata for notification deliveries', () => {
    const delivery: NotificationDelivery = {
      id: 'delivery-1',
      workspaceId: demoSeed.workspaceId,
      eventId: 'event-1',
      channel: 'telegram',
      deliveredAt: null,
      version: 1,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      deletedAt: null,
    };
    const seed: WorkspaceSnapshot = { ...demoSeed, notificationDeliveries: [delivery] };
    const repository = createDemoRepository({ seed, persistence: createMemoryPersistence() });

    expect(repository.snapshot().notificationDeliveries).toEqual([delivery]);
  });

  it('never searches secure URLs or private safe fields', () => {
    const repository = createRepository();
    repository.createSecureItem({
      title: 'Касса',
      purpose: 'very-private-metadata',
      owner: 'Управляющий',
      externalUrl: 'https://vault.bitwarden.com/#/items/very-private-url',
    });

    expect(repository.search('very-private')).toEqual([]);
  });

  it('matches production merged-state validation for knowledge patches', () => {
    const invalidRepository = createRepository();
    const note = invalidRepository.snapshot().knowledge.find((item) => item.kind === 'instruction')!;
    expect(() => invalidRepository.updateKnowledge(note.id, { linkUrl: 'https://example.com/guide' }, note.version)).toThrow();
    expect(invalidRepository.snapshot().knowledge.find((item) => item.id === note.id)).toMatchObject({ version: note.version, linkUrl: null });

    const validRepository = createRepository();
    const current = validRepository.snapshot().knowledge.find((item) => item.kind === 'instruction')!;
    const linked = validRepository.updateKnowledge(current.id, { kind: 'link', linkUrl: 'https://example.com/guide' }, current.version);
    const relinked = validRepository.updateKnowledge(linked.id, { linkUrl: 'https://example.com/new' }, linked.version);
    const converted = validRepository.updateKnowledge(relinked.id, { kind: 'note' }, relinked.version);
    expect(linked).toMatchObject({ kind: 'link', linkUrl: 'https://example.com/guide' });
    expect(relinked).toMatchObject({ kind: 'link', linkUrl: 'https://example.com/new' });
    expect(converted).toMatchObject({ kind: 'note', linkUrl: null });
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
