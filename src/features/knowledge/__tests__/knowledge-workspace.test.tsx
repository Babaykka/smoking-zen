import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { ConflictError } from '@/data/workspace-repository';
import { SafeMarkdown } from '@/components/safe-markdown';
import { KnowledgeWorkspace } from '@/features/knowledge/knowledge-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

describe('KnowledgeWorkspace', () => {
  beforeEach(() => window.localStorage.clear());

  it('creates, edits, archives, and restores a draft-safe knowledge item', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    render(<WorkspaceProvider gateway={createDemoGateway(repository)}><KnowledgeWorkspace /></WorkspaceProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Добавить материал' }));
    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Новый регламент' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByText('Новый регламент')).toBeInTheDocument();

    const createdCard = screen.getByRole('button', { name: 'Открыть материал Новый регламент' });
    createdCard.focus();
    fireEvent.click(createdCard);
    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Обновлённый регламент' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByText('Обновлённый регламент')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Архивировать материал' }));
    expect(await screen.findByRole('button', { name: 'Восстановить материал' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить материал' }));
    await waitFor(() => expect(screen.getByText('Обновлённый регламент')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Открыть материал Обновлённый регламент' })).toHaveFocus());
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

  it('rebases a preserved conflicting draft onto actualVersion before retrying', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.updateKnowledge = vi.fn(async (id, input, expectedVersion) => {
      if (expectedVersion === 1) throw new ConflictError(1, 2);
      return { ...gateway.snapshot().knowledge.find((item) => item.id === id)!, ...input, version: 3, updatedAt: '2026-08-02T12:00:00.000Z' };
    });
    render(<WorkspaceProvider gateway={gateway}><KnowledgeWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть материал Плотная забивка чаши' }));
    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Мой конфликтный черновик' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Черновик сохранён');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить сохранение' }));
    await waitFor(() => expect(gateway.updateKnowledge).toHaveBeenLastCalledWith(
      'knowledge-bowl', expect.objectContaining({ title: 'Мой конфликтный черновик' }), 2,
    ));
    expect(screen.getByLabelText('Название материала')).toHaveValue('Мой конфликтный черновик');
  });

  it('shows restore failures after the detail panel has closed', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.restoreKnowledge = vi.fn().mockRejectedValue(new Error('Срок восстановления истёк'));
    render(<WorkspaceProvider gateway={gateway}><KnowledgeWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть материал Плотная забивка чаши' }));
    fireEvent.click(screen.getByRole('button', { name: 'Архивировать материал' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Восстановить материал' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Срок восстановления истёк');
  });

  it('consumes keyed search navigation once, preserves drafts on refetch, and can reopen the same item', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const gateway = createDemoGateway(repository);
    const consumed = vi.fn();
    const rendered = render(<WorkspaceProvider gateway={gateway}><KnowledgeWorkspace onSearchTargetConsumed={consumed} searchTarget={{ id: 'knowledge-bowl', requestKey: 1 }} /></WorkspaceProvider>);
    expect(await screen.findByLabelText('Название материала')).toHaveValue('Плотная забивка чаши');
    expect(consumed).toHaveBeenCalledWith(1);
    fireEvent.change(screen.getByLabelText('Название материала'), { target: { value: 'Несохранённый черновик' } });
    await act(() => gateway.createKnowledge({ title: 'Событие Realtime', kind: 'note' }));
    expect(screen.getByLabelText('Название материала')).toHaveValue('Несохранённый черновик');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    rendered.rerender(<WorkspaceProvider gateway={gateway}><KnowledgeWorkspace onSearchTargetConsumed={consumed} searchTarget={{ id: 'knowledge-bowl', requestKey: 2 }} /></WorkspaceProvider>);
    await waitFor(() => expect(screen.getByLabelText('Название материала')).toHaveValue('Плотная забивка чаши'));
    expect(consumed).toHaveBeenLastCalledWith(2);
  });

  it('uses localized kind labels and the mobile detail layout class', async () => {
    render(<WorkspaceProvider gateway={createDemoGateway(createDemoRepository({ loadPersisted: false }))}><KnowledgeWorkspace /></WorkspaceProvider>);
    expect(screen.getByText('Инструкция')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть материал Плотная забивка чаши' }));
    expect(screen.getByRole('complementary', { name: 'Детали материала' }).parentElement).toHaveClass('tasks-workspace--detail');
  });
});
