import type { Priority, Task, TaskStatus } from '@/domain/types';
import { moscowDateKey } from '@/domain/moscow-time';

export type TaskDeadlineFilter = 'today' | 'overdue' | 'no-deadline';

export type TaskFilter = {
  priorities?: Priority[];
  statusIds?: string[];
  sectionIds?: string[];
  assigneeIds?: string[];
  unassignedOnly?: boolean;
  deadline?: TaskDeadlineFilter;
  now?: Date;
  includeCompleted?: boolean;
};

export function matchesTaskFilter(
  task: Task,
  filter: TaskFilter,
  statuses: readonly TaskStatus[] = [],
): boolean {
  if (task.deletedAt !== null) return false;
  const status = statuses.find((candidate) => candidate.id === task.statusId);
  if (!filter.includeCompleted && status?.isCompleted) return false;
  if (filter.priorities && !filter.priorities.includes(task.priority)) return false;
  if (filter.statusIds && !filter.statusIds.includes(task.statusId)) return false;
  if (filter.sectionIds && (!task.sectionId || !filter.sectionIds.includes(task.sectionId))) return false;
  if (filter.assigneeIds && (!task.assigneeId || !filter.assigneeIds.includes(task.assigneeId))) return false;
  if (filter.unassignedOnly && task.assigneeId !== null) return false;
  if (filter.deadline === 'no-deadline' && task.dueAt !== null) return false;
  if (filter.deadline === 'today') {
    if (!task.dueAt || moscowDateKey(new Date(task.dueAt)) !== moscowDateKey(filter.now ?? new Date())) return false;
  }
  if (filter.deadline === 'overdue') {
    if (!task.dueAt || moscowDateKey(new Date(task.dueAt)) >= moscowDateKey(filter.now ?? new Date())) return false;
  }
  return true;
}
