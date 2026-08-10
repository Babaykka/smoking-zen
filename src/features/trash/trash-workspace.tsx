'use client';

import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { formatMoscowDateTime } from '@/domain/moscow-time';
import type { TrashItem } from '@/domain/types';
import { AuditHistory } from '@/components/audit-history';
import { useWorkspace } from '@/providers/workspace-provider';

const entityLabels: Record<TrashItem['entity'], string> = {
  task: 'Задача',
  knowledge: 'Материал',
  contact: 'Контакт',
  secureItem: 'Запись сейфа',
  attachment: 'Файл',
};

export function TrashWorkspace() {
  const { repository, snapshot } = useWorkspace();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const trashItems = snapshot.trashItems ?? [];

  const restore = async (item: TrashItem) => {
    setBusyId(item.id);
    setError('');
    try {
      if (item.entity === 'task') await repository.restoreTask(item.id, item.version);
      else if (item.entity === 'knowledge') await repository.restoreKnowledge(item.id, item.version);
      else if (item.entity === 'contact') await repository.restoreContact(item.id, item.version);
      else if (item.entity === 'secureItem') await repository.restoreSecureItem(item.id, item.version);
      else await repository.restoreAttachment(item.id, item.version);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось восстановить запись.');
    } finally {
      setBusyId(null);
    }
  };

  return <section className="trash-workspace">
    <header className="tasks-header"><div><p className="workspace-loading__eyebrow">Smoking Zen</p><h1>Корзина</h1></div></header>
    <p className="trash-workspace__hint"><Trash2 aria-hidden="true" size={18} />Удалённые записи хранятся 30 дней.</p>
    <div className="trash-list">
      {trashItems.map((item) => <article className="trash-card" key={`${item.entity}:${item.id}`}>
        <div><span>{entityLabels[item.entity]}</span><h2>{item.title}</h2><p>Удалено {formatMoscowDateTime(item.deletedAt)}</p></div>
        <AuditHistory entity={item.entity} entityId={item.id} events={snapshot.auditEvents} label={`История: ${item.title}`} />
        <button aria-label={`Восстановить ${item.title}`} disabled={busyId !== null} onClick={() => void restore(item)} type="button"><RotateCcw aria-hidden="true" size={18} />Восстановить</button>
      </article>)}
      {!trashItems.length && <p className="task-empty">Корзина пуста.</p>}
    </div>
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </section>;
}
