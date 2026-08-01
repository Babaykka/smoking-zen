import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { WorkspaceProvider, useWorkspace } from '@/providers/workspace-provider';

function TaskCount() {
  const { snapshot } = useWorkspace();
  return <output>{snapshot.tasks.length}</output>;
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
});
