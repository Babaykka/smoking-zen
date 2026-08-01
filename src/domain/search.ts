import type { Contact, KnowledgeItem, SearchResult, Task } from '@/domain/types';

type SearchableWorkspace = {
  tasks: Task[];
  knowledge: KnowledgeItem[];
  contacts: Contact[];
};

function includesQuery(value: string, query: string) {
  return value.toLocaleLowerCase('ru-RU').includes(query);
}

export function searchWorkspace(workspace: SearchableWorkspace, input: string): SearchResult[] {
  const query = input.trim().toLocaleLowerCase('ru-RU');
  if (!query) return [];

  return [
    ...workspace.tasks
      .filter((task) => task.deletedAt === null && includesQuery(`${task.title} ${task.description}`, query))
      .map((task) => ({ entity: 'task' as const, id: task.id, title: task.title })),
    ...workspace.knowledge
      .filter((item) => item.deletedAt === null && includesQuery(`${item.title} ${item.body}`, query))
      .map((item) => ({ entity: 'knowledge' as const, id: item.id, title: item.title })),
    ...workspace.contacts
      .filter((contact) =>
        contact.deletedAt === null &&
        includesQuery(`${contact.name} ${contact.notes} ${contact.methods.map((method) => method.value).join(' ')}`, query),
      )
      .map((contact) => ({ entity: 'contact' as const, id: contact.id, title: contact.name })),
  ];
}
