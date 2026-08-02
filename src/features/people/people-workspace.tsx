'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { ConflictError } from '@/data/workspace-repository';
import { contactInputSchema } from '@/domain/schemas';
import type { Contact, ContactCategory, ContactMethod, SearchNavigationTarget } from '@/domain/types';
import { useWorkspace } from '@/providers/workspace-provider';

const categoryLabels: Record<ContactCategory, string> = { supplier: 'Поставщики', service: 'Сервис и мастера', landlord: 'Партнёры и арендодатель', cleaning: 'Клининг', other: 'Прочее' };

export function contactMethodHref(method: ContactMethod): string | null {
  if (method.kind === 'phone') return /^\+\d{7,15}$/.test(method.value) ? `tel:${method.value}` : null;
  if (method.kind === 'telegram') return /^[A-Za-z0-9_]{5,32}$/.test(method.value) ? `https://t.me/${method.value}` : null;
  return /^\d{7,15}$/.test(method.value) ? `https://wa.me/${method.value}` : null;
}

function ContactAction({ contactName, method }: { contactName: string; method: ContactMethod }) {
  const href = contactMethodHref(method);
  const label = `${method.kind === 'phone' ? 'Позвонить' : method.kind === 'telegram' ? 'Telegram' : 'WhatsApp'} ${contactName}`;
  const visibleLabel = method.kind === 'phone' ? 'Телефон' : method.kind === 'telegram' ? 'Telegram' : 'WhatsApp';
  return href ? <a aria-label={label} className="contact-action" href={href} rel={method.kind === 'phone' ? undefined : 'noopener noreferrer'} target={method.kind === 'phone' ? undefined : '_blank'}>{visibleLabel}</a> : <span className="contact-action">{visibleLabel}</span>;
}

export function PeopleWorkspace({
  searchTarget,
  onSearchTargetConsumed,
}: {
  searchTarget?: SearchNavigationTarget;
  onSearchTargetConsumed?: (requestKey: number) => void;
}) {
  const { repository, snapshot } = useWorkspace();
  const [tab, setTab] = useState<'team' | 'contacts'>('team');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ContactCategory>('other');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [archived, setArchived] = useState<Contact | null>(null);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const contactsRef = useRef(snapshot.contacts);
  const teamTabRef = useRef<HTMLButtonElement>(null);
  const contactsTabRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { contactsRef.current = snapshot.contacts; }, [snapshot.contacts]);
  const begin = (contact?: Contact, returnFocus?: HTMLElement | null) => { if (returnFocus !== undefined) returnFocusRef.current = returnFocus; setEditing(true); setSelected(contact ?? null); setExpectedVersion(contact?.version ?? 0); setName(contact?.name ?? ''); setCategory(contact?.category ?? 'other'); setPhone(contact?.methods.find((method) => method.kind === 'phone')?.value ?? ''); setTelegram(contact?.methods.find((method) => method.kind === 'telegram')?.value ?? ''); setWhatsapp(contact?.methods.find((method) => method.kind === 'whatsapp')?.value ?? ''); setNotes(contact?.notes ?? ''); setError(''); };
  useEffect(() => {
    if (!searchTarget) return;
    const timer = window.setTimeout(() => {
      const contact = contactsRef.current.find((candidate) => candidate.id === searchTarget.id);
      if (contact) { returnFocusRef.current = null; setTab('contacts'); begin(contact); }
      onSearchTargetConsumed?.(searchTarget.requestKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onSearchTargetConsumed, searchTarget]);
  const activateTab = (next: 'team' | 'contacts', focus = false) => {
    setTab(next);
    if (focus) (next === 'team' ? teamTabRef : contactsTabRef).current?.focus();
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: 'team' | 'contacts' | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = tab === 'team' ? 'contacts' : 'team';
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = tab === 'team' ? 'contacts' : 'team';
    if (event.key === 'End') next = 'contacts';
    if (event.key === 'Home') next = 'team';
    if (next) { event.preventDefault(); activateTab(next, true); }
  };
  const close = () => {
    const selectedId = selected?.id;
    setEditing(false); setSelected(null); setError('');
    window.setTimeout(() => {
      const fallback = selectedId
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-contact-id]')).find((element) => element.dataset.contactId === selectedId) ?? null
        : null;
      (returnFocusRef.current?.isConnected ? returnFocusRef.current : fallback)?.focus();
      returnFocusRef.current = null;
    }, 0);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = contactInputSchema.safeParse({ name, category, notes, methods: [
        ...(phone.trim() ? [{ kind: 'phone' as const, value: phone }] : []),
        ...(telegram.trim() ? [{ kind: 'telegram' as const, value: telegram }] : []),
        ...(whatsapp.trim() ? [{ kind: 'whatsapp' as const, value: whatsapp }] : []),
      ] });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Проверьте контакт.'); return; }
      const contact = selected ? await repository.updateContact(selected.id, parsed.data, expectedVersion) : await repository.createContact(parsed.data);
      begin(contact);
    } catch (cause) { if (cause instanceof ConflictError) setExpectedVersion(cause.actualVersion); setError(cause instanceof ConflictError ? 'Контакт изменён другим пользователем. Черновик сохранён.' : cause instanceof Error ? cause.message : 'Не удалось сохранить контакт.'); }
  };
  const archive = async () => { if (!selected) return; try { setArchived(await repository.deleteContact(selected.id, expectedVersion)); setSelected(null); setEditing(false); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось архивировать контакт.'); } };
  const restore = async () => { if (!archived) return; try { begin(await repository.restoreContact(archived.id, archived.version)); setArchived(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось восстановить контакт.'); } };
  return <section className="people-workspace"><header className="tasks-header"><div><p className="workspace-loading__eyebrow">Smoking Zen</p><h1>Люди</h1></div></header>
    <div aria-label="Люди" className="people-tabs" role="tablist"><button aria-controls="team-panel" aria-selected={tab === 'team'} id="team-tab" onClick={() => activateTab('team')} onKeyDown={handleTabKey} ref={teamTabRef} role="tab" tabIndex={tab === 'team' ? 0 : -1} type="button">Команда</button><button aria-controls="contacts-panel" aria-selected={tab === 'contacts'} id="contacts-tab" onClick={() => activateTab('contacts')} onKeyDown={handleTabKey} ref={contactsTabRef} role="tab" tabIndex={tab === 'contacts' ? 0 : -1} type="button">Контакты</button></div>
    {tab === 'team' ? <div aria-labelledby="team-tab" id="team-panel" role="tabpanel" className="people-panel people-team">{snapshot.members.map((member) => <p className="people-card" key={member.id}>{member.name}{member.active ? '' : ' · неактивен'}</p>)}</div> : <div aria-labelledby="contacts-tab" className="people-panel" id="contacts-panel" role="tabpanel"><button className="task-secondary-button" onClick={(event) => begin(undefined, event.currentTarget)} type="button">Добавить контакт</button><div className="contact-groups">{(Object.keys(categoryLabels) as ContactCategory[]).map((group) => <section className="contact-group" key={group}><h2>{categoryLabels[group]}</h2>{snapshot.contacts.filter((contact) => contact.category === group).map((contact) => <article className="contact-card" key={contact.id}><button data-contact-id={contact.id} onClick={(event) => begin(contact, event.currentTarget)} type="button">{contact.name}</button><div className="contact-actions">{contact.methods.map((method) => <ContactAction contactName={contact.name} key={`${method.kind}-${method.value}`} method={method} />)}</div></article>)}</section>)}</div>
      {editing && <form aria-label="Контакт" className="contact-form" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }} onSubmit={save}><label>Имя контакта<input onChange={(event) => setName(event.target.value)} value={name} /></label><label>Категория<select onChange={(event) => setCategory(event.target.value as ContactCategory)} value={category}>{(Object.keys(categoryLabels) as ContactCategory[]).map((value) => <option key={value} value={value}>{categoryLabels[value]}</option>)}</select></label><label>Телефон<input onChange={(event) => setPhone(event.target.value)} value={phone} /></label><label>Telegram<input onChange={(event) => setTelegram(event.target.value)} value={telegram} /></label><label>WhatsApp<input onChange={(event) => setWhatsapp(event.target.value)} value={whatsapp} /></label><label>Заметка<textarea onChange={(event) => setNotes(event.target.value)} value={notes} /></label><div className="contact-form__actions"><button className="task-primary-button" type="submit">Сохранить контакт</button>{selected && <button className="task-secondary-button" onClick={archive} type="button">Архивировать контакт</button>}<button className="task-secondary-button" onClick={close} type="button">Закрыть контакт</button></div></form>}{archived && <button className="task-secondary-button" onClick={restore} type="button">Восстановить контакт</button>}</div>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </section>;
}
