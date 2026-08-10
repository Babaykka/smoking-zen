import { describe, expect, it } from 'vitest';

import { matchesTaskFilter, type TaskFilter } from '@/domain/filters';
import { searchWorkspace } from '@/domain/search';
import type { Contact, KnowledgeItem, Task, TaskStatus } from '@/domain/types';

const timestamps = {
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  deletedAt: null,
  version: 1,
  workspaceId: 'workspace-demo',
};

const task: Task = {
  ...timestamps,
  id: 'task-1',
  title: 'Проверить поставку табака',
  description: '',
  priority: 2,
  statusId: 'status-new',
  sectionId: null,
  assigneeId: null,
  dueAt: null,
  attachments: [],
};

const taskStatuses: TaskStatus[] = [
  {
    ...timestamps,
    id: 'status-new',
    name: 'Открыта',
    position: 1,
    isCompleted: false,
  },
  {
    ...timestamps,
    id: 'status-closed-custom',
    name: 'Архивный финал',
    position: 2,
    isCompleted: true,
  },
];

const knowledge: KnowledgeItem = {
  ...timestamps,
  id: 'knowledge-1',
  title: 'Инструкция по чаше',
  body: 'Используйте плотную забивку.',
  kind: 'instruction',
  linkUrl: null,
  sectionId: 'section-knowledge',
  attachments: [],
};

const contact: Contact = {
  ...timestamps,
  id: 'contact-1',
  name: 'Поставщик табака',
  category: 'supplier',
  notes: '',
  methods: [{ kind: 'phone', value: '+79990000000' }],
};

describe('workspace filtering and search', () => {
  it('filters a task by its priority and active status', () => {
    expect(matchesTaskFilter(task, { priorities: [2], statusIds: ['status-new'] }, taskStatuses)).toBe(true);
    expect(matchesTaskFilter(task, { priorities: [3] }, taskStatuses)).toBe(false);
  });

  it('hides completed tasks by dictionary data unless completed visibility is enabled', () => {
    const completed = { ...task, statusId: 'status-closed-custom' };

    expect(matchesTaskFilter(completed, {}, taskStatuses)).toBe(false);
    expect(matchesTaskFilter(completed, { includeCompleted: true }, taskStatuses)).toBe(true);
    expect(matchesTaskFilter(task, {}, taskStatuses)).toBe(true);
  });

  it('combines assignee, section, priority, status, and Moscow deadline filters including null values', () => {
    const now = new Date('2026-08-02T21:15:00.000Z');
    const dueToday = {
      ...task,
      assigneeId: null,
      sectionId: 'section-service',
      priority: 1 as const,
      dueAt: '2026-08-03T10:00:00.000Z',
    };
    const combined = {
      priorities: [1],
      statusIds: ['status-new'],
      sectionIds: ['section-service'],
      unassignedOnly: true,
      deadline: 'today',
      now,
    } as TaskFilter;

    expect(matchesTaskFilter(dueToday, combined, taskStatuses)).toBe(true);
    expect(matchesTaskFilter({ ...dueToday, assigneeId: 'member-1' }, combined, taskStatuses)).toBe(false);
    expect(matchesTaskFilter({ ...dueToday, dueAt: null }, combined, taskStatuses)).toBe(false);
    expect(matchesTaskFilter({ ...dueToday, dueAt: null }, { deadline: 'no-deadline', now } as TaskFilter, taskStatuses)).toBe(true);
  });

  it('searches visible task, knowledge, and contact content only', () => {
    expect(searchWorkspace({ tasks: [task], knowledge: [knowledge], contacts: [contact] }, 'табак')).toEqual([
      { entity: 'task', id: 'task-1', title: 'Проверить поставку табака' },
      { entity: 'contact', id: 'contact-1', title: 'Поставщик табака' },
    ]);
  });

  it('matches the bounded production search contract and excludes method values and link URLs', () => {
    const tasks = Array.from({ length: 25 }, (_, index) => ({ ...task, id: `task-${index}`, title: `Смена ${index} needle` }));
    const privateFieldsContact = { ...contact, name: 'Мастер', methods: [{ kind: 'phone' as const, value: '+79990000000' }] };
    const linkedKnowledge = { ...knowledge, title: 'Внешний документ', body: '', kind: 'link' as const, linkUrl: 'https://private.example/needle' };

    expect(searchWorkspace({ tasks, knowledge: [linkedKnowledge], contacts: [privateFieldsContact] }, 'needle')).toHaveLength(20);
    expect(searchWorkspace({ tasks: [], knowledge: [linkedKnowledge], contacts: [privateFieldsContact] }, 'private.example')).toEqual([]);
    expect(searchWorkspace({ tasks: [], knowledge: [], contacts: [privateFieldsContact] }, '79990000000')).toEqual([]);
    expect(searchWorkspace({ tasks, knowledge: [], contacts: [] }, 'x'.repeat(121))).toEqual([]);
  });

  it('orders all entity types together by most recent activity before applying the result limit', () => {
    const olderTask = { ...task, title: 'Общий запрос — задача', updatedAt: '2026-08-01T08:00:00.000Z' };
    const newestKnowledge = { ...knowledge, title: 'Общий запрос — материал', updatedAt: '2026-08-03T08:00:00.000Z' };
    const middleContact = { ...contact, name: 'Общий запрос — контакт', updatedAt: '2026-08-02T08:00:00.000Z' };
    expect(searchWorkspace({ tasks: [olderTask], knowledge: [newestKnowledge], contacts: [middleContact] }, 'общий запрос')).toEqual([
      { entity: 'knowledge', id: 'knowledge-1', title: 'Общий запрос — материал' },
      { entity: 'contact', id: 'contact-1', title: 'Общий запрос — контакт' },
      { entity: 'task', id: 'task-1', title: 'Общий запрос — задача' },
    ]);
  });

  it('treats SQL wildcard characters literally and resolves timestamp ties deterministically', () => {
    const percentTask = { ...task, id: 'task-percent', title: 'Скидка 10%' };
    const underscoreTask = { ...task, id: 'task-underscore', title: 'Код A_B' };
    const tiedContact = { ...contact, id: 'contact-tie', name: 'tie marker' };
    const tiedKnowledge = { ...knowledge, id: 'knowledge-tie', title: 'tie marker' };
    const tiedTask = { ...task, id: 'task-tie', title: 'tie marker' };
    expect(searchWorkspace({ tasks: [percentTask, underscoreTask], knowledge: [], contacts: [] }, '%')).toEqual([
      { entity: 'task', id: 'task-percent', title: 'Скидка 10%' },
    ]);
    expect(searchWorkspace({ tasks: [percentTask, underscoreTask], knowledge: [], contacts: [] }, '_')).toEqual([
      { entity: 'task', id: 'task-underscore', title: 'Код A_B' },
    ]);
    expect(searchWorkspace({ tasks: [tiedTask], knowledge: [tiedKnowledge], contacts: [tiedContact] }, 'tie marker')).toEqual([
      { entity: 'task', id: 'task-tie', title: 'tie marker' },
      { entity: 'knowledge', id: 'knowledge-tie', title: 'tie marker' },
      { entity: 'contact', id: 'contact-tie', title: 'tie marker' },
    ]);
  });
});
