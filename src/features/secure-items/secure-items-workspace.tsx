'use client';

import { ExternalLink, Plus, ShieldCheck } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { ConflictError } from '@/data/workspace-repository';
import type { SecureItemInput, SecureItemPatchInput } from '@/domain/schemas';
import type { SecureItemSummary } from '@/domain/types';
import { useWorkspace } from '@/providers/workspace-provider';

type SafeDraft = {
  title: string;
  purpose: string;
  owner: string;
  reviewDate: string;
  cardBank: string;
  cardHolder: string;
  cardPurpose: string;
  lastFour: string;
  externalUrl: string;
};

const emptyDraft = (): SafeDraft => ({
  title: '', purpose: '', owner: '', reviewDate: '', cardBank: '', cardHolder: '', cardPurpose: '', lastFour: '', externalUrl: '',
});

function draftFrom(item: SecureItemSummary): SafeDraft {
  return {
    title: item.title,
    purpose: item.purpose,
    owner: item.owner,
    reviewDate: item.reviewDate ?? '',
    cardBank: item.cardBank ?? '',
    cardHolder: item.cardHolder ?? '',
    cardPurpose: item.cardPurpose ?? '',
    lastFour: item.lastFour ?? '',
    externalUrl: '',
  };
}

function inputFromDraft(draft: SafeDraft): SecureItemInput {
  return {
    title: draft.title,
    purpose: draft.purpose,
    owner: draft.owner,
    reviewDate: draft.reviewDate || null,
    cardBank: draft.cardBank || null,
    cardHolder: draft.cardHolder || null,
    cardPurpose: draft.cardPurpose || null,
    lastFour: draft.lastFour || null,
    externalUrl: draft.externalUrl,
  };
}

export function SecureItemsWorkspace() {
  const { repository, snapshot } = useWorkspace();
  const [editing, setEditing] = useState<SecureItemSummary | 'new' | null>(null);
  const [draft, setDraft] = useState<SafeDraft>(emptyDraft);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [archived, setArchived] = useState<SecureItemSummary | null>(null);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<'save' | 'delete' | 'restore' | 'reveal' | null>(null);
  const operationRef = useRef<typeof operation>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const recoveryButtonRef = useRef<HTMLButtonElement | null>(null);
  const recoveryFocusPendingRef = useRef(false);
  const restoreFocusPendingRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (editing) {
      titleInputRef.current?.focus();
    } else if (restoreFocusPendingRef.current) {
      restoreFocusPendingRef.current = false;
      openerRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing && archived && operation === null && recoveryFocusPendingRef.current) {
      recoveryFocusPendingRef.current = false;
      recoveryButtonRef.current?.focus();
    }
  }, [archived, editing, operation]);

  const startOperation = (next: NonNullable<typeof operation>) => {
    if (operationRef.current) return false;
    operationRef.current = next;
    setOperation(next);
    return true;
  };

  const finishOperation = () => {
    operationRef.current = null;
    setOperation(null);
  };

  const restoreOpenerFocus = () => {
    restoreFocusPendingRef.current = true;
  };

  const beginCreate = (event: ReactMouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    setEditing('new');
    setDraft(emptyDraft());
    setExpectedVersion(0);
    setError('');
  };
  const beginEdit = (item: SecureItemSummary, event: ReactMouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    setEditing(item);
    setDraft(draftFrom(item));
    setExpectedVersion(item.version);
    setError('');
  };
  const close = () => {
    if (operationRef.current) return;
    setDraft(emptyDraft());
    setEditing(null);
    setError('');
    restoreOpenerFocus();
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.purpose.trim() || !draft.owner.trim()) {
      setError('Заполните название, назначение и ответственного.');
      return;
    }
    if (editing === 'new' && !draft.externalUrl.trim()) {
      setError('Укажите ссылку Bitwarden.');
      return;
    }
    if (!startOperation('save')) return;
    try {
      if (editing === 'new') {
        await repository.createSecureItem(inputFromDraft(draft));
      } else if (editing) {
        const input = inputFromDraft(draft);
        const { externalUrl, ...summary } = input;
        const patch: SecureItemPatchInput = externalUrl ? { ...summary, externalUrl } : summary;
        await repository.updateSecureItem(editing.id, patch, expectedVersion);
      }
      setDraft(emptyDraft());
      setEditing(null);
      setError('');
      restoreOpenerFocus();
    } catch (cause) {
      if (cause instanceof ConflictError) setExpectedVersion(cause.actualVersion);
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить запись.');
    } finally {
      finishOperation();
    }
  };

  const remove = async () => {
    if (!editing || editing === 'new') return;
    if (!startOperation('delete')) return;
    try {
      const deleted = await repository.deleteSecureItem(editing.id, expectedVersion);
      recoveryFocusPendingRef.current = true;
      setArchived(deleted);
      setDraft(emptyDraft());
      setEditing(null);
      setError('');
    } catch (cause) {
      if (cause instanceof ConflictError) setExpectedVersion(cause.actualVersion);
      setError(cause instanceof Error ? cause.message : 'Не удалось архивировать запись.');
    } finally {
      finishOperation();
    }
  };

  const restore = async () => {
    if (!archived) return;
    if (!startOperation('restore')) return;
    try {
      await repository.restoreSecureItem(archived.id, archived.version);
      setArchived(null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось восстановить запись.');
    } finally {
      finishOperation();
    }
  };

  const reveal = async (item: SecureItemSummary) => {
    if (!startOperation('reveal')) return;
    setError('');
    try {
      const { externalUrl } = await repository.revealSecureItem(item.id);
      window.open(externalUrl, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть Bitwarden.');
    } finally {
      finishOperation();
    }
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !operationRef.current) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...(editorRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((control) => !control.hasAttribute('hidden'));
    if (!controls.length) return;
    const first = controls[0]!;
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section className={`safe-workspace${editing ? ' safe-workspace--detail' : ''}`}>
      <div aria-hidden={editing ? true : undefined} className="safe-workspace__main" inert={editing ? true : undefined}>
        <header className="tasks-header">
          <div><p className="workspace-loading__eyebrow">Smoking Zen</p><h1>Сейф</h1></div>
          <button className="task-secondary-button" disabled={operation !== null} onClick={beginCreate} type="button"><Plus aria-hidden="true" size={18} /> Добавить запись</button>
        </header>
        <div className="safe-notice"><ShieldCheck aria-hidden="true" size={22} /><p><strong>Секреты остаются в Bitwarden.</strong><br />Здесь хранятся только назначение, ответственный и безопасная ссылка.</p></div>
        {archived && <div className="safe-recovery" role="status"><span>Запись «{archived.title}» архивирована.</span><button disabled={operation !== null} onClick={() => void restore()} ref={recoveryButtonRef} type="button">Восстановить запись</button></div>}
        <div className="safe-grid">
          {snapshot.secureItems.map((item) => (
            <article className="safe-card" key={item.id}>
              <div><h2>{item.title}</h2><p>{item.purpose}</p></div>
              <dl>
                <div><dt>Ответственный</dt><dd>{item.owner}</dd></div>
                {item.reviewDate && <div><dt>Проверка</dt><dd>{item.reviewDate}</dd></div>}
                {item.cardBank && <div><dt>Банк</dt><dd>{item.cardBank}</dd></div>}
                {item.lastFour && <div><dt>Карта</dt><dd>•••• {item.lastFour}</dd></div>}
              </dl>
              <div className="safe-card__actions">
                <button aria-label={`Открыть Bitwarden для ${item.title}`} disabled={operation !== null} onClick={() => void reveal(item)} type="button"><ExternalLink aria-hidden="true" size={17} /> Открыть Bitwarden</button>
                <button aria-label={`Изменить ${item.title}`} disabled={operation !== null} onClick={(event) => beginEdit(item, event)} type="button">Изменить</button>
              </div>
            </article>
          ))}
          {!snapshot.secureItems.length && <p className="task-empty">Безопасных ссылок пока нет.</p>}
        </div>
        {error && !editing && <p className="workspace-error" role="alert">{error}</p>}
      </div>

      {editing && (
        <aside
          aria-busy={operation !== null ? true : undefined}
          aria-labelledby="safe-editor-title"
          aria-modal="true"
          className="safe-editor"
          onKeyDown={handleEditorKeyDown}
          ref={editorRef}
          role="dialog"
        >
          <div className="safe-editor__heading">
            <h2 id="safe-editor-title">{editing === 'new' ? 'Новая безопасная запись' : `Редактирование: ${editing.title}`}</h2>
            <button aria-label="Закрыть редактор" className="task-detail__close" disabled={operation !== null} onClick={close} type="button">Закрыть</button>
          </div>
          <form autoComplete="off" onSubmit={save}>
            <label>Название записи<input ref={titleInputRef} onChange={(event) => setDraft({ ...draft, title: event.target.value })} value={draft.title} /></label>
            <label>Назначение<textarea onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} rows={3} value={draft.purpose} /></label>
            <label>Ответственный<input onChange={(event) => setDraft({ ...draft, owner: event.target.value })} value={draft.owner} /></label>
            <label>Дата проверки<input onChange={(event) => setDraft({ ...draft, reviewDate: event.target.value })} type="date" value={draft.reviewDate} /></label>
            <fieldset><legend>Безопасные данные карты — необязательно</legend>
              <label>Банк<input onChange={(event) => setDraft({ ...draft, cardBank: event.target.value })} value={draft.cardBank} /></label>
              <label>Держатель карты<input onChange={(event) => setDraft({ ...draft, cardHolder: event.target.value })} value={draft.cardHolder} /></label>
              <label>Назначение карты<input onChange={(event) => setDraft({ ...draft, cardPurpose: event.target.value })} value={draft.cardPurpose} /></label>
              <label>Последние четыре цифры<input inputMode="numeric" maxLength={4} onChange={(event) => setDraft({ ...draft, lastFour: event.target.value.replace(/\D/gu, '') })} value={draft.lastFour} /></label>
            </fieldset>
            <label>Ссылка Bitwarden<input autoCapitalize="none" onChange={(event) => setDraft({ ...draft, externalUrl: event.target.value })} placeholder={editing === 'new' ? 'https://vault.bitwarden.com/…' : 'Оставьте пустым, чтобы не менять'} spellCheck={false} type="url" value={draft.externalUrl} /></label>
            <p className="safe-editor__hint">Пароли, PIN, CVV, OTP и полные номера карт здесь не сохраняются.</p>
            <div className="safe-editor__actions"><button className="task-primary-button" disabled={operation !== null} type="submit">Сохранить запись</button>{editing !== 'new' && <button className="task-secondary-button" disabled={operation !== null} onClick={() => void remove()} type="button">Архивировать</button>}</div>
            {error && <p className="workspace-error" role="alert">{error}</p>}
          </form>
        </aside>
      )}
    </section>
  );
}
