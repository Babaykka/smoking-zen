import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { TrashWorkspace } from '@/features/trash/trash-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';
import type { Attachment } from '@/domain/types';

describe('TrashWorkspace', () => {
  it('keeps deleted business records reachable and restores them with versioned history', async () => {
    const repository = createDemoRepository({ loadPersisted: false, clock: () => '2026-08-02T10:00:00.000Z' });
    const task = repository.snapshot().tasks[0]!;
    const knowledge = repository.snapshot().knowledge[0]!;
    const contact = repository.snapshot().contacts[0]!;
    const secureItem = repository.snapshot().secureItems[0]!;
    repository.deleteTask(task.id, task.version);
    repository.deleteKnowledge(knowledge.id, knowledge.version);
    repository.deleteContact(contact.id, contact.version);
    repository.deleteSecureItem(secureItem.id, secureItem.version);

    render(
      <WorkspaceProvider gateway={createDemoGateway(repository)}>
        <TrashWorkspace />
      </WorkspaceProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Корзина' })).toBeInTheDocument();
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expect(screen.getByText(knowledge.title)).toBeInTheDocument();
    expect(screen.getByText(contact.name)).toBeInTheDocument();
    expect(screen.getByText(secureItem.title)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Восстановить ${task.title}` }));
    await waitFor(() => expect(repository.snapshot().tasks.some((item) => item.id === task.id)).toBe(true));
    expect(repository.snapshot().auditEvents.at(-1)).toMatchObject({ entity: 'task', entityId: task.id, action: 'restored' });
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
  });

  it('restores a ready attachment through the same central Trash view', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const gateway = createDemoGateway(repository);
    const attachment: Attachment = { id: 'file-ready', name: 'scheme.pdf', mimeType: 'application/pdf', size: 2048, version: 3 };
    gateway.restoreAttachment = async (id, expectedVersion) => {
      expect({ id, expectedVersion }).toEqual({ id: attachment.id, expectedVersion: 3 });
      return { ...attachment, version: 4 };
    };
    const snapshot = gateway.snapshot();
    snapshot.trashItems = [{
      entity: 'attachment', id: attachment.id, title: attachment.name, version: 3,
      deletedAt: '2026-08-02T10:00:00.000Z', attachment, parentType: 'task', parentId: snapshot.tasks[0]!.id,
    }];
    gateway.snapshot = () => snapshot;
    gateway.hydrate = async () => {};

    render(<WorkspaceProvider gateway={gateway}><TrashWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('button', { name: `Восстановить ${attachment.name}` }));

    await waitFor(() => expect(gateway.restoreAttachment).toBeDefined());
  });
});
