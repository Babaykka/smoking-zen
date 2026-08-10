import type { WorkspaceSnapshot } from '@/domain/types';

const workspaceId = 'workspace-smoking-zen-demo';
const createdAt = '2026-08-01T09:00:00.000Z';

export const demoSeed: WorkspaceSnapshot = {
  workspaceId,
  taskStatuses: [
    { id: 'status-new', workspaceId, name: 'Новая', position: 1, isCompleted: false, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'status-in-progress', workspaceId, name: 'В работе', position: 2, isCompleted: false, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'status-waiting', workspaceId, name: 'Ждёт', position: 3, isCompleted: false, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'status-done', workspaceId, name: 'Готово', position: 4, isCompleted: true, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
  ],
  sections: [
    { id: 'section-opening', workspaceId, name: 'Открытие', position: 1, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-repair', workspaceId, name: 'Ремонт и техника', position: 2, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-stock', workspaceId, name: 'Закупки и склад', position: 3, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-service', workspaceId, name: 'Зал и сервис', position: 4, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-people', workspaceId, name: 'Персонал', position: 5, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-marketing', workspaceId, name: 'Маркетинг', position: 6, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-documents', workspaceId, name: 'Документы и финансы', position: 7, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
    { id: 'section-safety', workspaceId, name: 'Безопасность и санитария', position: 8, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
  ],
  tasks: [
    {
      id: 'task-check-coals', workspaceId, title: 'Проверить запас кокосового угля', description: 'Сверить остаток перед вечерней сменой.', priority: 2,
      statusId: 'status-new', sectionId: 'section-stock', assigneeId: 'member-alina', dueAt: '2026-08-02T15:00:00.000Z', attachments: [],
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
  ],
  comments: [],
  knowledge: [
    {
      id: 'knowledge-bowl', workspaceId, title: 'Плотная забивка чаши', body: 'Перед подачей проверьте тягу и чистоту колбы.', kind: 'instruction', linkUrl: null, sectionId: 'section-documents', attachments: [],
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
    {
      id: 'knowledge-guide', workspaceId, title: 'Регламент санитарной обработки', body: 'Откройте официальный регламент перед сменой.', kind: 'link', linkUrl: 'https://example.com/sanitary-guide', sectionId: 'section-safety', attachments: [],
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
    { id: 'member-ilya', workspaceId, name: 'Илья', role: 'member', active: false, version: 1, createdAt, updatedAt: createdAt, deletedAt: null },
  ],
  secureItems: [
    {
      id: 'secure-pos', workspaceId, title: 'Касса', purpose: 'Доступ к основной кассе', owner: 'Управляющий', reviewDate: null,
      cardBank: 'Тестовый банк', cardHolder: null, cardPurpose: 'Операционные расходы', lastFour: '0000',
      version: 1, createdAt, updatedAt: createdAt, deletedAt: null,
    },
  ],
  auditEvents: [],
  notificationDeliveries: [],
};

export const demoSecureItemRevealUrls: Readonly<Record<string, string>> = {
  'secure-pos': 'https://vault.bitwarden.com/#/items/demo-pos',
};
