import { describe, expect, it } from 'vitest';

import { matchesTaskFilter } from '@/domain/filters';
import { searchWorkspace } from '@/domain/search';
import type { Contact, KnowledgeItem, Task } from '@/domain/types';

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

const knowledge: KnowledgeItem = {
  ...timestamps,
  id: 'knowledge-1',
  title: 'Инструкция по чаше',
  body: 'Используйте плотную забивку.',
  kind: 'instruction',
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
    expect(matchesTaskFilter(task, { priorities: [2], statusIds: ['status-new'] })).toBe(true);
    expect(matchesTaskFilter(task, { priorities: [3] })).toBe(false);
  });

  it('searches visible task, knowledge, and contact content only', () => {
    expect(searchWorkspace({ tasks: [task], knowledge: [knowledge], contacts: [contact] }, 'табак')).toEqual([
      { entity: 'task', id: 'task-1', title: 'Проверить поставку табака' },
      { entity: 'contact', id: 'contact-1', title: 'Поставщик табака' },
    ]);
  });
});
