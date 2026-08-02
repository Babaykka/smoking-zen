'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { SafeMarkdown } from '@/components/safe-markdown';
import { ConflictError } from '@/data/workspace-repository';
import { knowledgeInputSchema } from '@/domain/schemas';
import type { KnowledgeItem, KnowledgeKind } from '@/domain/types';
import { useWorkspace } from '@/providers/workspace-provider';

type KnowledgeDraft = Pick<KnowledgeItem, 'title' | 'body' | 'kind' | 'linkUrl' | 'sectionId'>;

function draftFrom(item: KnowledgeItem): KnowledgeDraft {
  return { title: item.title, body: item.body, kind: item.kind, linkUrl: item.linkUrl, sectionId: item.sectionId };
}

export function KnowledgeWorkspace({ searchTargetId }: { searchTargetId?: string }) {
  const { repository, snapshot } = useWorkspace();
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [archived, setArchived] = useState<KnowledgeItem | null>(null);

  const open = (item: KnowledgeItem) => { setSelected(item); setDraft(draftFrom(item)); setError(''); };
  useEffect(() => {
    const item = snapshot.knowledge.find((candidate) => candidate.id === searchTargetId);
    const timer = window.setTimeout(() => { if (item) open(item); }, 0);
    return () => window.clearTimeout(timer);
  }, [searchTargetId, snapshot.knowledge]);
  const save = async () => {
    if (!draft) return;
    const parsed = knowledgeInputSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Проверьте заполнение материала.'); return; }
    try {
      const item = selected
        ? await repository.updateKnowledge(selected.id, { title: parsed.data.title, body: parsed.data.body, kind: parsed.data.kind, linkUrl: parsed.data.linkUrl, sectionId: parsed.data.sectionId }, selected.version)
        : await repository.createKnowledge(parsed.data);
      setSelected(item); setDraft(draftFrom(item)); setCreating(false); setError('');
    } catch (cause) {
      setError(cause instanceof ConflictError ? 'Материал изменён другим пользователем. Черновик сохранён.' : cause instanceof Error ? cause.message : 'Не удалось сохранить материал.');
    }
  };
  const archive = async () => {
    if (!selected) return;
    try { setArchived(await repository.deleteKnowledge(selected.id, selected.version)); setSelected(null); setDraft(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось архивировать материал.'); }
  };
  const restore = async () => {
    if (!archived) return;
    try { const restored = await repository.restoreKnowledge(archived.id, archived.version); setArchived(null); open(restored); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось восстановить материал.'); }
  };

  return <section className="tasks-workspace">
    <div className="tasks-workspace__list">
      <header className="tasks-header"><div><p className="workspace-loading__eyebrow">Smoking Zen</p><h1>База знаний</h1></div><button className="task-secondary-button" onClick={() => { setCreating(true); setSelected(null); setDraft({ title: '', body: '', kind: 'note', linkUrl: null, sectionId: null }); }} type="button">Добавить материал</button></header>
      <div className="task-list">{snapshot.knowledge.map((item) => <button aria-label={`Открыть материал ${item.title}`} className="task-card" key={item.id} onClick={() => open(item)} type="button"><span className="task-card__body"><strong>{item.title}</strong><small>{item.kind}</small></span></button>)}</div>
    </div>
    {(selected || creating) && draft && <aside aria-label="Детали материала" className="task-detail"><button className="task-detail__close" onClick={() => { setSelected(null); setCreating(false); }} type="button">Закрыть</button><form onSubmit={(event: FormEvent) => { event.preventDefault(); void save(); }}>
      <label>Название материала<input onChange={(event) => setDraft({ ...draft, title: event.target.value })} value={draft.title} /></label>
      <label>Содержание<textarea onChange={(event) => setDraft({ ...draft, body: event.target.value })} value={draft.body} /></label>
      <label>Тип<select onChange={(event) => setDraft({ ...draft, kind: event.target.value as KnowledgeKind })} value={draft.kind}><option value="note">Заметка</option><option value="instruction">Инструкция</option><option value="document">Документ</option><option value="link">Ссылка</option></select></label>
      {draft.kind === 'link' && <label>HTTPS-ссылка<input onChange={(event) => setDraft({ ...draft, linkUrl: event.target.value || null })} value={draft.linkUrl ?? ''} /></label>}
      <label>Раздел<select onChange={(event) => setDraft({ ...draft, sectionId: event.target.value || null })} value={draft.sectionId ?? ''}><option value="">Без раздела</option>{snapshot.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>
      <div aria-label="Предпросмотр материала"><SafeMarkdown value={draft.body} /></div><button className="task-primary-button" type="submit">Сохранить материал</button>
    </form>{selected && <button onClick={archive} type="button">Архивировать материал</button>}{error && <><p role="alert">{error}</p>{error.includes('Черновик') && <button onClick={() => { void save(); }} type="button">Повторить сохранение</button>}</>}</aside>}
    {archived && <button onClick={restore} type="button">Восстановить материал</button>}
  </section>;
}
