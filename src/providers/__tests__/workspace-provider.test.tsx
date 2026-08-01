import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { demoSeed } from '@/data/demo-seed';
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
      <WorkspaceProvider repository={repository}>
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
      <WorkspaceProvider>
        <FirstTaskTitle />
      </WorkspaceProvider>,
    );

    expect(await screen.findByText(persistedTitle)).toBeInTheDocument();
    window.localStorage.removeItem('smoking-zen-demo-workspace');
  });
});
