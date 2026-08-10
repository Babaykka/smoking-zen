'use client';

import { Download, FilePlus2, RotateCcw, Trash2 } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';

import { FILE_ACCEPT, type AttachmentTarget } from '@/domain/files';
import type { Attachment } from '@/domain/types';
import { AuditHistory } from '@/components/audit-history';
import { useWorkspace } from '@/providers/workspace-provider';

function readableSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} КиБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МиБ`;
}

export function AttachmentWidget({ attachments, target }: { attachments: Attachment[]; target: AttachmentTarget }) {
  const { repository, snapshot } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [retryFile, setRetryFile] = useState<File | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setProgress(0);
    setStatus('Подготавливаем безопасную загрузку…');
    setError('');
    try {
      const uploaded = await repository.uploadAttachment(target, file, (percent) => {
        setProgress(percent);
        setStatus(percent < 80 ? `Загрузка: ${percent}%` : percent < 100 ? 'Проверяем содержимое файла…' : '');
      });
      setRetryFile(null);
      setProgress(100);
      setStatus(`Файл ${uploaded.name} добавлен.`);
    } catch (cause) {
      setRetryFile(file);
      setStatus('');
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить файл.');
    } finally {
      setBusy(false);
    }
  };

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void upload(file);
  };

  const download = async (attachment: Attachment) => {
    setError('');
    try {
      const signed = await repository.downloadAttachment(attachment.id);
      window.open(signed.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось скачать файл.');
    }
  };

  const archive = async (attachment: Attachment) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await repository.deleteAttachment(attachment.id, attachment.version);
      setStatus(`Файл ${attachment.name} перемещён в корзину.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось удалить файл.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-busy={busy ? true : undefined} aria-labelledby={`attachments-${target.type}-${target.id}`} className="attachment-widget">
      <div className="attachment-widget__header">
        <div>
          <h2 id={`attachments-${target.type}-${target.id}`}>Файлы</h2>
          <p>До 25 МиБ · JPEG, PNG, WebP, PDF, TXT, DOCX или XLSX.</p>
        </div>
        <label className="attachment-widget__picker">
          <FilePlus2 aria-hidden="true" size={18} />
          <span>Добавить файл</span>
          <input aria-label="Добавить файл" accept={FILE_ACCEPT} disabled={busy} onChange={choose} type="file" />
        </label>
      </div>

      {repository.fileStorageMode === 'metadata-only' && (
        <p className="attachment-widget__demo-note" role="note">
          В демо-режиме сохраняются только название и сведения о файле. Содержимое файла не сохраняется, поэтому скачать его позже нельзя.
        </p>
      )}

      {attachments.length > 0 && (
        <ul className="attachment-widget__list">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span><strong>{attachment.name}</strong><small>{readableSize(attachment.size)}</small></span>
              <button aria-label={`Скачать ${attachment.name}`} onClick={() => void download(attachment)} type="button">
                <Download aria-hidden="true" size={18} />
              </button>
              <button aria-label={`Удалить ${attachment.name}`} disabled={busy} onClick={() => void archive(attachment)} type="button">
                <Trash2 aria-hidden="true" size={18} />
              </button>
              <AuditHistory entity="attachment" entityId={attachment.id} events={snapshot.auditEvents} label={`История файла ${attachment.name}`} />
            </li>
          ))}
        </ul>
      )}
      {busy && <progress aria-label="Прогресс загрузки" max={100} value={progress} />}
      {status && <p className="attachment-widget__status" role="status">{status}</p>}
      {error && <p className="task-validation-error" role="alert">{error}</p>}
      {retryFile && !busy && (
        <button className="attachment-widget__retry" onClick={() => void upload(retryFile)} type="button">
          <RotateCcw aria-hidden="true" size={17} /> Повторить загрузку
        </button>
      )}
    </section>
  );
}
