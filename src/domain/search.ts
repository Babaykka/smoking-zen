import type { Contact, KnowledgeItem, SearchResult, Task } from '@/domain/types';

type SearchableWorkspace = {
  tasks: Task[];
  knowledge: KnowledgeItem[];
  contacts: Contact[];
};

const entityRank = { task: 0, knowledge: 1, contact: 2 } as const;

export const MAX_SEARCH_QUERY_LENGTH = 120;
export const MAX_SEARCH_RESULTS = 20;

function includesQuery(value: string, query: string) {
  return value.toLocaleLowerCase('ru-RU').includes(query);
}

export function searchWorkspace(workspace: SearchableWorkspace, input: string): SearchResult[] {
  const query = input.trim().toLocaleLowerCase('ru-RU');
  if (!query || query.length > MAX_SEARCH_QUERY_LENGTH) return [];

  return [
    ...workspace.tasks
      .filter((task) => task.deletedAt === null && includesQuery(`${task.title} ${task.description}`, query))
      .map((task) => ({ entity: 'task' as const, id: task.id, title: task.title, updatedAt: task.updatedAt })),
    ...workspace.knowledge
      .filter((item) => item.deletedAt === null && includesQuery(`${item.title} ${item.body}`, query))
      .map((item) => ({ entity: 'knowledge' as const, id: item.id, title: item.title, updatedAt: item.updatedAt })),
    ...workspace.contacts
      .filter((contact) =>
        contact.deletedAt === null &&
        includesQuery(`${contact.name} ${contact.notes}`, query),
      )
      .map((contact) => ({ entity: 'contact' as const, id: contact.id, title: contact.name, updatedAt: contact.updatedAt })),
  ]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      entityRank[left.entity] - entityRank[right.entity] || left.id.localeCompare(right.id))
    .slice(0, MAX_SEARCH_RESULTS)
    .map(({ entity, id, title }) => ({ entity, id, title }));
}
