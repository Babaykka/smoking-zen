'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { ConflictError } from '@/data/workspace-repository';
import { contactInputSchema } from '@/domain/schemas';
import type { Contact, ContactCategory, ContactMethod } from '@/domain/types';
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
  return href ? <a aria-label={label} href={href} rel={method.kind === 'phone' ? undefined : 'noopener noreferrer'} target={method.kind === 'phone' ? undefined : '_blank'}>{method.kind}</a> : <span>{method.kind}</span>;
}

export function PeopleWorkspace({ searchTargetId }: { searchTargetId?: string }) {
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
  const begin = (contact?: Contact) => { setEditing(true); setSelected(contact ?? null); setName(contact?.name ?? ''); setCategory(contact?.category ?? 'other'); setPhone(contact?.methods.find((method) => method.kind === 'phone')?.value ?? ''); setTelegram(contact?.methods.find((method) => method.kind === 'telegram')?.value ?? ''); setWhatsapp(contact?.methods.find((method) => method.kind === 'whatsapp')?.value ?? ''); setNotes(contact?.notes ?? ''); setError(''); };
  useEffect(() => {
    const contact = snapshot.contacts.find((candidate) => candidate.id === searchTargetId);
    const timer = window.setTimeout(() => { if (contact) { setTab('contacts'); begin(contact); } }, 0);
    return () => window.clearTimeout(timer);
  }, [searchTargetId, snapshot.contacts]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = contactInputSchema.safeParse({ name, category, notes, methods: [
        ...(phone.trim() ? [{ kind: 'phone' as const, value: phone }] : []),
        ...(telegram.trim() ? [{ kind: 'telegram' as const, value: telegram }] : []),
        ...(whatsapp.trim() ? [{ kind: 'whatsapp' as const, value: whatsapp }] : []),
      ] });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Проверьте контакт.'); return; }
      const contact = selected ? await repository.updateContact(selected.id, parsed.data, selected.version) : await repository.createContact(parsed.data);
      begin(contact);
    } catch (cause) { setError(cause instanceof ConflictError ? 'Контакт изменён другим пользователем. Черновик сохранён.' : cause instanceof Error ? cause.message : 'Не удалось сохранить контакт.'); }
  };
  const archive = async () => { if (!selected) return; try { setArchived(await repository.deleteContact(selected.id, selected.version)); setSelected(null); setEditing(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось архивировать контакт.'); } };
  const restore = async () => { if (!archived) return; try { begin(await repository.restoreContact(archived.id, archived.version)); setArchived(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось восстановить контакт.'); } };
  return <section className="tasks-workspace"><header className="tasks-header"><div><p className="workspace-loading__eyebrow">Smoking Zen</p><h1>Люди</h1></div></header>
    <div aria-label="Люди" role="tablist"><button aria-controls="team-panel" aria-selected={tab === 'team'} id="team-tab" onClick={() => setTab('team')} role="tab" type="button">Команда</button><button aria-controls="contacts-panel" aria-selected={tab === 'contacts'} id="contacts-tab" onClick={() => setTab('contacts')} role="tab" type="button">Контакты</button></div>
    {tab === 'team' ? <div aria-labelledby="team-tab" id="team-panel" role="tabpanel" className="task-list">{snapshot.members.map((member) => <p key={member.id}>{member.name}{member.active ? '' : ' · неактивен'}</p>)}</div> : <div aria-labelledby="contacts-tab" id="contacts-panel" role="tabpanel"><button onClick={() => begin()} type="button">Добавить контакт</button>{(Object.keys(categoryLabels) as ContactCategory[]).map((group) => <section key={group}><h2>{categoryLabels[group]}</h2>{snapshot.contacts.filter((contact) => contact.category === group).map((contact) => <article key={contact.id}><button onClick={() => begin(contact)} type="button">{contact.name}</button>{contact.methods.map((method) => <ContactAction contactName={contact.name} key={`${method.kind}-${method.value}`} method={method} />)}</article>)}</section>)}
      {editing && <form aria-label="Контакт" onSubmit={save}><label>Имя контакта<input onChange={(event) => setName(event.target.value)} value={name} /></label><label>Категория<select onChange={(event) => setCategory(event.target.value as ContactCategory)} value={category}>{(Object.keys(categoryLabels) as ContactCategory[]).map((value) => <option key={value} value={value}>{categoryLabels[value]}</option>)}</select></label><label>Телефон<input onChange={(event) => setPhone(event.target.value)} value={phone} /></label><label>Telegram<input onChange={(event) => setTelegram(event.target.value)} value={telegram} /></label><label>WhatsApp<input onChange={(event) => setWhatsapp(event.target.value)} value={whatsapp} /></label><label>Заметка<textarea onChange={(event) => setNotes(event.target.value)} value={notes} /></label><button type="submit">Сохранить контакт</button>{selected && <button onClick={archive} type="button">Архивировать контакт</button>}{error && <p role="alert">{error}</p>}</form>}{archived && <button onClick={restore} type="button">Восстановить контакт</button>}</div>}
  </section>;
}
