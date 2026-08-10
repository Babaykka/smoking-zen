'use client';

import { useId } from 'react';

import { formatMoscowDateTime } from '@/domain/moscow-time';
import type { AuditEvent, WorkspaceEntity } from '@/domain/types';

const actionLabels: Record<AuditEvent['action'], string> = {
  created: 'Создание',
  updated: 'Изменение',
  deleted: 'Удаление',
  restored: 'Восстановление',
};

const MAX_VISIBLE_EVENTS = 50;

export function AuditHistory({
  entity,
  entityId,
  events,
  label = 'История',
  defaultOpen = false,
}: {
  entity: WorkspaceEntity;
  entityId: string;
  events: AuditEvent[];
  label?: string;
  defaultOpen?: boolean;
}) {
  const descriptionId = useId();
  const headingId = useId();
  const visibleEvents = events
    .filter((event) => event.entity === entity && event.entityId === entityId)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, MAX_VISIBLE_EVENTS);

  return (
    <section aria-labelledby={headingId} className="audit-history">
      <h2 id={headingId}>{label}</h2>
      <details open={defaultOpen || undefined}>
        <summary aria-describedby={descriptionId}>События <span aria-hidden="true">· {visibleEvents.length}</span></summary>
        <div id={descriptionId}>
          {visibleEvents.length ? (
            <ol>
              {visibleEvents.map((event) => (
                <li key={event.id}>
                  <span>{actionLabels[event.action]}</span>
                  <time dateTime={event.occurredAt}>{formatMoscowDateTime(event.occurredAt)}</time>
                </li>
              ))}
            </ol>
          ) : <p>Изменений пока нет.</p>}
        </div>
      </details>
    </section>
  );
}
