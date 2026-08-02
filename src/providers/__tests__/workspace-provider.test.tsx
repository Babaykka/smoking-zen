import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { demoSeed } from '@/data/demo-seed';
import { createDemoGateway } from '@/data/workspace-gateway';
import type { WorkspaceGateway } from '@/data/workspace-gateway';
import { WorkspaceProvider, useWorkspace } from '@/providers/workspace-provider';

function TaskCount() {
  const { snapshot } = useWorkspace();
  return <output>{snapshot.tasks.length}</output>;
}

function FirstTaskTitle() {
  const { snapshot } = useWorkspace();
  return <output>{snapshot.tasks[0]?.title}</output>;
}

describe('WorkspaceProvider', () => {
  it('renders a stable initial repository snapshot', () => {
    const repository = createDemoRepository({ persistence: { load: () => null, save: () => {} } });

    render(
      <WorkspaceProvider gateway={createDemoGateway(repository)}>
        <TaskCount />
      </WorkspaceProvider>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('1');
  });

  it('starts from the deterministic seed then hydrates default local persistence after mount', async () => {
    const persistedTitle = 'Задача из локального хранилища';
    const persistedSnapshot = {
      ...demoSeed,
      tasks: [{ ...demoSeed.tasks[0]!, title: persistedTitle }],
    };
    window.localStorage.setItem('smoking-zen-demo-workspace', JSON.stringify(persistedSnapshot));

    const repository = createDemoRepository();
    expect(repository.snapshot().tasks[0]?.title).toBe(demoSeed.tasks[0]?.title);

    render(
      <WorkspaceProvider gateway={createDemoGateway(repository)}>
        <FirstTaskTitle />
      </WorkspaceProvider>,
    );

    expect(await screen.findByText(persistedTitle)).toBeInTheDocument();
    window.localStorage.removeItem('smoking-zen-demo-workspace');
  });

  it('only owns its subscription and never disposes a reused gateway during StrictMode effects', async () => {
    const unsubscribe = vi.fn();
    const gateway: WorkspaceGateway = {
      snapshot: () => demoSeed,
      hydrate: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => unsubscribe),
      createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), restoreTask: vi.fn(), createComment: vi.fn(),
      dispose: vi.fn(),
    };

    const rendered = render(
      <StrictMode>
        <WorkspaceProvider gateway={gateway}><TaskCount /></WorkspaceProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(gateway.subscribe).toHaveBeenCalledTimes(2));

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(gateway.dispose).not.toHaveBeenCalled();
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(gateway.dispose).not.toHaveBeenCalled();
  });
});
