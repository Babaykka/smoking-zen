import type { Priority, Task } from '@/domain/types';

export type TaskFilter = {
  priorities?: Priority[];
  statusIds?: string[];
  sectionIds?: string[];
  assigneeIds?: string[];
  includeCompleted?: boolean;
};

export function matchesTaskFilter(task: Task, filter: TaskFilter): boolean {
  if (task.deletedAt !== null) return false;
  if (filter.priorities && !filter.priorities.includes(task.priority)) return false;
  if (filter.statusIds && !filter.statusIds.includes(task.statusId)) return false;
  if (filter.sectionIds && (!task.sectionId || !filter.sectionIds.includes(task.sectionId))) return false;
  if (filter.assigneeIds && (!task.assigneeId || !filter.assigneeIds.includes(task.assigneeId))) return false;
  return true;
}
