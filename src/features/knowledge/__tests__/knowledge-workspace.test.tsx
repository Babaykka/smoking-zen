import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { ConflictError } from '@/data/workspace-repository';
import { SafeMarkdown } from '@/components/safe-markdown';
import { KnowledgeWorkspace } from '@/features/knowledge/knowledge-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

describe('KnowledgeWorkspace', () => {
  it('creates, edits, archives, and restores a draft-safe knowledge item', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    render(<WorkspaceProvider gateway={createDemoGateway(repository)}><KnowledgeWorkspace /></WorkspaceProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Добавить материал' }));
    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Новый регламент' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByText('Новый регламент')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Открыть материал Новый регламент' }));
    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Обновлённый регламент' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByText('Обновлённый регламент')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Архивировать материал' }));
    expect(await screen.findByRole('button', { name: 'Восстановить материал' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить материал' }));
    await waitFor(() => expect(screen.getByText('Обновлённый регламент')).toBeInTheDocument());
  });

  it('renders neutral Markdown without scripts, unsafe links, or remote images', () => {
    render(<SafeMarkdown value={'- [x] Готово\n[Безопасно](https://example.com)\n[Опасно](javascript:alert(1))\n![внешнее](https://example.com/image.png)\n<script>alert(1)</script>'} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('link', { name: 'Безопасно' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: 'Опасно' })).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('keeps Russian invalid drafts and a conflicting draft available for retry', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.updateKnowledge = vi.fn().mockRejectedValue(new ConflictError(1, 2));
    render(<WorkspaceProvider gateway={gateway}><KnowledgeWorkspace /></WorkspaceProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Добавить материал' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Введите название материала');
    expect(screen.getByLabelText('Название материала')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Мой черновик' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByText('Мой черновик')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть материал Мой черновик' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Черновик сохранён');
    expect(screen.getByRole('button', { name: 'Повторить сохранение' })).toBeInTheDocument();
  });
});
