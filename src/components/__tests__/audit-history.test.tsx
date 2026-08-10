import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AuditHistory } from '@/components/audit-history';
import type { AuditEvent } from '@/domain/types';

const taskId = 'task-1';

describe('AuditHistory', () => {
  it('is keyboard-focusable, newest-first, metadata-only, and bounded to 50 matching events', () => {
    const events: AuditEvent[] = Array.from({ length: 60 }, (_, index) => ({
      id: `event-${index}`,
      workspaceId: 'workspace-1',
      entity: 'task',
      entityId: taskId,
      action: index % 2 ? 'updated' : 'created',
      occurredAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    }));
    events.push({ ...events[0]!, id: 'foreign', entity: 'secureItem', entityId: 'safe-1' });
    render(<AuditHistory defaultOpen entity="task" entityId={taskId} events={events} />);

    const summary = screen.getByText(/^События/u);
    summary.focus();
    expect(summary).toHaveFocus();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getAllByRole('time')[0]).toHaveAttribute('datetime', '2026-08-01T00:59:00.000Z');
    expect(document.body.textContent).not.toMatch(/Bitwarden|storage|signed|actor/iu);
  });

  it('has an explicit empty state', () => {
    render(<AuditHistory entity="attachment" entityId="file-1" events={[]} label="История файла" />);
    expect(screen.getByText('Изменений пока нет.')).toBeInTheDocument();
  });
});
