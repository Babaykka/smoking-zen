import type { WorkspaceSnapshot } from '@/domain/types';

const workspaceId = 'workspace-smoking-zen-demo';
const createdAt = '2026-08-01T09:00:00.000Z';

export const demoSeed: WorkspaceSnapshot = {
  workspaceId,
  taskStatuses: [
    { id: 'status-new', workspaceId, name: 'Новая', position: 1, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'status-in-progress', workspaceId, name: 'В работе', position: 2, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'status-waiting', workspaceId, name: 'Ждёт', position: 3, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'status-done', workspaceId, name: 'Готово', position: 4, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
  ],
  sections: [
    { id: 'section-operations', workspaceId, name: 'Операции', position: 1, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-knowledge', workspaceId, name: 'База знаний', position: 2, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
  ],
  tasks: [
    {
      id: 'task-check-coals', workspaceId, title: 'Проверить запас кокосового угля', description: 'Сверить остаток перед вечерней сменой.', priority: 2,
      statusId: 'status-new', sectionId: 'section-operations', assigneeId: 'member-alina', dueAt: '2026-08-02T15:00:00.000Z', attachments: [],
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
  ],
  comments: [],
  knowledge: [
    {
      id: 'knowledge-bowl', workspaceId, title: 'Плотная забивка чаши', body: 'Перед подачей проверьте тягу и чистоту колбы.', kind: 'instruction', sectionId: 'section-knowledge', attachments: [],
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
  ],
  contacts: [
    {
      id: 'contact-coal-supplier', workspaceId, name: 'Поставщик угля', category: 'supplier', notes: 'Доставка до 12:00 по будням.', methods: [{ kind: 'phone', value: '+79990000000' }],
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
  ],
  members: [
    { id: 'member-owner', workspaceId, name: 'Алексей', role: 'owner', active: true, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'member-alina', workspaceId, name: 'Алина', role: 'member', active: true, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
  ],
  secureItems: [
    {
      id: 'secure-pos', workspaceId, title: 'Касса', externalUrl: 'https://vault.bitwarden.com/#/items/demo-pos', metadata: { location: 'Основной бар' },
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
  ],
  auditEvents: [],
  notificationDeliveries: [],
};
