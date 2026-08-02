'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { SafeMarkdown } from '@/components/safe-markdown';
import { AttachmentWidget } from '@/features/files/attachment-widget';
import { ConflictError } from '@/data/workspace-repository';
import { knowledgeInputSchema } from '@/domain/schemas';
import type { KnowledgeItem, KnowledgeKind, SearchNavigationTarget } from '@/domain/types';
import { useWorkspace } from '@/providers/workspace-provider';

type KnowledgeDraft = Pick<KnowledgeItem, 'title' | 'body' | 'kind' | 'linkUrl' | 'sectionId'>;

function draftFrom(item: KnowledgeItem): KnowledgeDraft {
  return { title: item.title, body: item.body, kind: item.kind, linkUrl: item.linkUrl, sectionId: item.sectionId };
}

const kindLabels: Record<KnowledgeKind, string> = {
  note: 'Заметка', instruction: 'Инструкция', document: 'Документ', link: 'Ссылка',
};

export function KnowledgeWorkspace({
  searchTarget,
  onSearchTargetConsumed,
}: {
  searchTarget?: SearchNavigationTarget;
  onSearchTargetConsumed?: (requestKey: number) => void;
}) {
  const { repository, snapshot } = useWorkspace();
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [archived, setArchived] = useState<KnowledgeItem | null>(null);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const knowledgeRef = useRef(snapshot.knowledge);
  const selectedRef = useRef<KnowledgeItem | null>(null);
  const pendingSaveRef = useRef<Promise<KnowledgeItem> | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { knowledgeRef.current = snapshot.knowledge; }, [snapshot.knowledge]);

  const open = (item: KnowledgeItem) => { selectedRef.current = item; setSelected(item); setDraft(draftFrom(item)); setExpectedVersion(item.version); setError(''); };
  useEffect(() => {
    if (!searchTarget) return;
    const timer = window.setTimeout(() => {
      const item = knowledgeRef.current.find((candidate) => candidate.id === searchTarget.id);
      if (item) open(item);
      onSearchTargetConsumed?.(searchTarget.requestKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onSearchTargetConsumed, searchTarget]);
  const close = () => {
    const selectedId = selected?.id;
    selectedRef.current = null;
    setSelected(null); setCreating(false); setDraft(null); setError('');
    window.setTimeout(() => {
      const fallback = selectedId
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-knowledge-id]')).find((element) => element.dataset.knowledgeId === selectedId) ?? null
        : null;
      (returnFocusRef.current?.isConnected ? returnFocusRef.current : fallback)?.focus();
      returnFocusRef.current = null;
    }, 0);
  };
  const save = async () => {
    if (!draft) return;
    const parsed = knowledgeInputSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Проверьте заполнение материала.'); return; }
    const operation = selected
      ? repository.updateKnowledge(selected.id, { title: parsed.data.title, body: parsed.data.body, kind: parsed.data.kind, linkUrl: parsed.data.linkUrl, sectionId: parsed.data.sectionId }, expectedVersion)
      : repository.createKnowledge(parsed.data);
    pendingSaveRef.current = operation;
    try {
      const item = await operation;
      selectedRef.current = item;
      setSelected(item); setDraft(draftFrom(item)); setExpectedVersion(item.version); setCreating(false); setError('');
    } catch (cause) {
      if (cause instanceof ConflictError) setExpectedVersion(cause.actualVersion);
      setError(cause instanceof ConflictError ? 'Материал изменён другим пользователем. Черновик сохранён.' : cause instanceof Error ? cause.message : 'Не удалось сохранить материал.');
    } finally {
      if (pendingSaveRef.current === operation) pendingSaveRef.current = null;
    }
  };
  const archive = async () => {
    let current = selectedRef.current ?? selected;
    if (!current) return;
    try {
      if (pendingSaveRef.current) current = await pendingSaveRef.current;
      setArchived(await repository.deleteKnowledge(current.id, current.version));
      selectedRef.current = null;
      setSelected(null); setDraft(null); setCreating(false); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось архивировать материал.'); }
  };
  const restore = async () => {
    if (!archived) return;
    try { const restored = await repository.restoreKnowledge(archived.id, archived.version); setArchived(null); open(restored); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось восстановить материал.'); }
  };

  return <section className={`tasks-workspace${selected || creating ? ' tasks-workspace--detail' : ''}`}>
    <div className="tasks-workspace__list">
      <header className="tasks-header"><div><p className="workspace-loading__eyebrow">Smoking Zen</p><h1>База знаний</h1></div><button className="task-secondary-button" onClick={(event) => { returnFocusRef.current = event.currentTarget; setCreating(true); setSelected(null); setExpectedVersion(0); setError(''); setDraft({ title: '', body: '', kind: 'note', linkUrl: null, sectionId: null }); }} type="button">Добавить материал</button></header>
      <div className="task-list">{snapshot.knowledge.map((item) => <button aria-label={`Открыть материал ${item.title}`} className="task-card" data-knowledge-id={item.id} key={item.id} onClick={(event) => { returnFocusRef.current = event.currentTarget; open(item); }} type="button"><span className="task-card__body"><strong>{item.title}</strong><small>{kindLabels[item.kind]}</small></span></button>)}</div>
    </div>
    {(selected || creating) && draft && <aside aria-label="Детали материала" className="task-detail"><button autoFocus className="task-detail__close" onClick={close} type="button">Закрыть</button><form onSubmit={(event: FormEvent) => { event.preventDefault(); void save(); }}>
      <label>Название материала<input onChange={(event) => setDraft({ ...draft, title: event.target.value })} value={draft.title} /></label>
      <label>Содержание<textarea onChange={(event) => setDraft({ ...draft, body: event.target.value })} value={draft.body} /></label>
      <label>Тип<select onChange={(event) => setDraft({ ...draft, kind: event.target.value as KnowledgeKind, linkUrl: event.target.value === 'link' ? draft.linkUrl : null })} value={draft.kind}>{(Object.keys(kindLabels) as KnowledgeKind[]).map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>
      {draft.kind === 'link' && <label>HTTPS-ссылка<input onChange={(event) => setDraft({ ...draft, linkUrl: event.target.value || null })} value={draft.linkUrl ?? ''} /></label>}
      <label>Раздел<select onChange={(event) => setDraft({ ...draft, sectionId: event.target.value || null })} value={draft.sectionId ?? ''}><option value="">Без раздела</option>{snapshot.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>
      <div aria-label="Предпросмотр материала"><SafeMarkdown value={draft.body} /></div><button className="task-primary-button" type="submit">Сохранить материал</button>
    </form>{selected && <AttachmentWidget attachments={snapshot.knowledge.find((item) => item.id === selected.id)?.attachments ?? selected.attachments} target={{ type: 'knowledge', id: selected.id }} />}{selected && <button onClick={archive} type="button">Архивировать материал</button>}{error.includes('Черновик') && <button onClick={() => { void save(); }} type="button">Повторить сохранение</button>}</aside>}
    {archived && <button onClick={restore} type="button">Восстановить материал</button>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </section>;
}
