import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { SecureItemsWorkspace } from '@/features/secure-items/secure-items-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

function renderSafe() {
  const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
  render(<WorkspaceProvider gateway={gateway}><SecureItemsWorkspace /></WorkspaceProvider>);
  return gateway;
}

describe('SecureItemsWorkspace', () => {
  beforeEach(() => window.localStorage.clear());

  it('renders fixed summary metadata with masked last four and no external URL', () => {
    renderSafe();
    expect(screen.getByText('•••• 0000')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/vault\.bitwarden|#\/items/iu);
    expect(screen.getByText(/Секреты остаются в Bitwarden/iu)).toBeInTheDocument();
  });

  it('reveals and opens Bitwarden only after the explicit user action', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const gateway = renderSafe();
    const reveal = vi.spyOn(gateway, 'revealSecureItem');
    fireEvent.click(screen.getByRole('button', { name: /Открыть Bitwarden для Касса/iu }));
    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/vault\.bitwarden\.com\//u), '_blank', 'noopener,noreferrer');
    expect(document.body.textContent).not.toMatch(/vault\.bitwarden|#\/items/iu);
  });

  it('creates a fixed-field summary while keeping the entered URL out of the rendered draft after save', async () => {
    const gateway = renderSafe();
    const create = vi.spyOn(gateway, 'createSecureItem');
    fireEvent.click(screen.getByRole('button', { name: 'Добавить запись' }));
    fireEvent.change(screen.getByLabelText('Название записи'), { target: { value: 'Терминал' } });
    fireEvent.change(screen.getByLabelText('Назначение'), { target: { value: 'Оплата' } });
    fireEvent.change(screen.getByLabelText('Ответственный'), { target: { value: 'Управляющий' } });
    const externalUrl = 'https://vault.bitwarden.com/#/items/new-memory-only';
    fireEvent.change(screen.getByLabelText('Ссылка Bitwarden'), { target: { value: externalUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить запись' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Терминал', externalUrl })));
    await waitFor(() => expect(screen.queryByLabelText('Ссылка Bitwarden')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(externalUrl);
  });

  it('single-flights a duplicate create submit while the first request is pending', async () => {
    const gateway = renderSafe();
    let resolveCreate!: (value: Awaited<ReturnType<typeof gateway.createSecureItem>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof gateway.createSecureItem>>>((resolve) => {
      resolveCreate = resolve;
    });
    const create = vi.spyOn(gateway, 'createSecureItem').mockImplementation(() => pending);
    fireEvent.click(screen.getByRole('button', { name: 'Добавить запись' }));
    fireEvent.change(screen.getByLabelText('Название записи'), { target: { value: 'Терминал' } });
    fireEvent.change(screen.getByLabelText('Назначение'), { target: { value: 'Оплата' } });
    fireEvent.change(screen.getByLabelText('Ответственный'), { target: { value: 'Управляющий' } });
    fireEvent.change(screen.getByLabelText('Ссылка Bitwarden'), {
      target: { value: 'https://vault.bitwarden.com/#/items/single-flight' },
    });
    const submit = screen.getByRole('button', { name: 'Сохранить запись' });

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(create).toHaveBeenCalledOnce();
    expect(submit).toBeDisabled();
    resolveCreate({
      id: 'safe-single-flight', workspaceId: 'workspace-demo', title: 'Терминал', purpose: 'Оплата', owner: 'Управляющий',
      reviewDate: null, cardBank: null, cardHolder: null, cardPurpose: null, lastFour: null,
      version: 1, createdAt: '2026-08-02T12:00:00.000Z', updatedAt: '2026-08-02T12:00:00.000Z', deletedAt: null,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens an accessible dialog, focuses its first field, and restores opener focus on close and save', async () => {
    renderSafe();
    const opener = screen.getByRole('button', { name: 'Добавить запись' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Новая безопасная запись' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Название записи')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть редактор' }));
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(opener);
    fireEvent.change(screen.getByLabelText('Название записи'), { target: { value: 'Терминал' } });
    fireEvent.change(screen.getByLabelText('Назначение'), { target: { value: 'Оплата' } });
    fireEvent.change(screen.getByLabelText('Ответственный'), { target: { value: 'Управляющий' } });
    fireEvent.change(screen.getByLabelText('Ссылка Bitwarden'), {
      target: { value: 'https://vault.bitwarden.com/#/items/focus-return' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить запись' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('archives and restores Safe metadata within the recovery window without revealing its URL', async () => {
    const gateway = renderSafe();
    const restore = vi.spyOn(gateway, 'restoreSecureItem');
    fireEvent.click(screen.getByRole('button', { name: 'Изменить Касса' }));
    fireEvent.click(screen.getByRole('button', { name: 'Архивировать' }));

    const restoreButton = await screen.findByRole('button', { name: 'Восстановить запись' });
    expect(screen.queryByRole('heading', { name: 'Касса' })).not.toBeInTheDocument();
    expect(restoreButton).toHaveFocus();
    fireEvent.click(restoreButton);

    await waitFor(() => expect(restore).toHaveBeenCalled());
    expect(await screen.findByRole('heading', { name: 'Касса' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/vault\.bitwarden|#\/items/iu);
  });
});
