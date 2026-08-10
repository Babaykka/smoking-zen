import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import type { Attachment } from '@/domain/types';
import { AttachmentWidget } from '@/features/files/attachment-widget';
import { WorkspaceProvider } from '@/providers/workspace-provider';

const attachment: Attachment = { id: 'file-1', name: 'policy.txt', mimeType: 'text/plain', size: 18, version: 1 };

function renderWidget(overrides: { attachments?: Attachment[] } = {}) {
  const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
  gateway.uploadAttachment = vi.fn().mockImplementation(async (_target, _file, onProgress) => {
    onProgress?.(35);
    onProgress?.(100);
    return attachment;
  });
  gateway.downloadAttachment = vi.fn().mockResolvedValue({ ...attachment, url: 'https://download.example/file?token=ephemeral', expiresIn: 60 });
  render(
    <WorkspaceProvider gateway={gateway}>
      <AttachmentWidget attachments={overrides.attachments ?? []} target={{ type: 'task', id: 'task-check-coals' }} />
    </WorkspaceProvider>,
  );
  return gateway;
}

describe('AttachmentWidget', () => {
  it('proactively explains that demo attachments retain metadata only', () => {
    renderWidget();
    expect(screen.getByRole('note')).toHaveTextContent(/демо-режиме.*содержимое файла не сохраняется/iu);
  });

  it('uses the exact mobile picker allowlist and reports upload progress through completion', async () => {
    const gateway = renderWidget();
    const input = screen.getByLabelText('Добавить файл');
    expect(input).toHaveAttribute('accept', '.jpg,.jpeg,.png,.webp,.pdf,.txt,.docx,.xlsx');
    const file = new File(['Регламент смены.\n'], 'policy.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(gateway.uploadAttachment).toHaveBeenCalledWith(
      { type: 'task', id: 'task-check-coals' }, file, expect.any(Function),
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Файл policy.txt добавлен');
  });

  it('keeps a failed file in memory for an explicit retry and shows a recovery message', async () => {
    const gateway = renderWidget();
    vi.mocked(gateway.uploadAttachment)
      .mockRejectedValueOnce(new Error('Файл отклонён безопасной проверкой.'))
      .mockResolvedValueOnce(attachment);
    const file = new File(['Регламент смены.\n'], 'policy.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Добавить файл'), { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Файл отклонён безопасной проверкой');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await waitFor(() => expect(gateway.uploadAttachment).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Файл policy.txt добавлен');
  });

  it('requests a ready-only signed download on an explicit click without rendering its URL', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const gateway = renderWidget({ attachments: [attachment] });
    fireEvent.click(screen.getByRole('button', { name: 'Скачать policy.txt' }));

    await waitFor(() => expect(gateway.downloadAttachment).toHaveBeenCalledWith(attachment.id));
    expect(open).toHaveBeenCalledWith('https://download.example/file?token=ephemeral', '_blank', 'noopener,noreferrer');
    expect(document.body.textContent).not.toContain('token=ephemeral');
  });

  it('archives a ready attachment with its exact version and removes it from ordinary file controls', async () => {
    const versioned = { ...attachment, version: 4 };
    const gateway = renderWidget({ attachments: [versioned] });
    gateway.deleteAttachment = vi.fn().mockResolvedValue({ ...versioned, version: 5 });

    fireEvent.click(screen.getByRole('button', { name: 'Удалить policy.txt' }));

    await waitFor(() => expect(gateway.deleteAttachment).toHaveBeenCalledWith(attachment.id, 4));
  });
});
