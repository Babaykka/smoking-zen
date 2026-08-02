import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { ConflictError } from '@/data/workspace-repository';
import { contactMethodHref, PeopleWorkspace } from '@/features/people/people-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

describe('PeopleWorkspace', () => {
  beforeEach(() => window.localStorage.clear());

  it('never creates an action URL from malformed persisted method data', () => {
    expect(contactMethodHref({ kind: 'phone', value: 'javascript:alert(1)' })).toBeNull();
    expect(contactMethodHref({ kind: 'telegram', value: 'bad/path' })).toBeNull();
    expect(contactMethodHref({ kind: 'whatsapp', value: 'https://example.com' })).toBeNull();
  });

  it('provides Russian tabs, inactive team labels, categories, and normalized quick links', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    render(<WorkspaceProvider gateway={createDemoGateway(repository)}><PeopleWorkspace /></WorkspaceProvider>);

    expect(screen.getByRole('tab', { name: 'Команда' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Илья · неактивен')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Контакты' }));
    expect(screen.getByText('Поставщики')).toBeInTheDocument();
    expect(screen.getByText('Сервис и мастера')).toBeInTheDocument();
    expect(screen.getByText('Партнёры и арендодатель')).toBeInTheDocument();
    expect(screen.getByText('Клининг')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Позвонить Поставщик угля' })).toHaveAttribute('href', 'tel:+79990000000');
    expect(screen.getByRole('link', { name: 'Позвонить Поставщик угля' })).toHaveTextContent('Телефон');
  });

  it('awaits CRUD and preserves a malformed contact draft with an accessible error', async () => {
    const repository = createDemoRepository({ loadPersisted: false });
    render(<WorkspaceProvider gateway={createDemoGateway(repository)}><PeopleWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Контакты' }));
    fireEvent.click(screen.getByRole('button', { name: 'Добавить контакт' }));
    fireEvent.change(screen.getByLabelText('Имя контакта'), { target: { value: 'Мастер Антон' } });
    fireEvent.change(screen.getByLabelText('Telegram'), { target: { value: '@bad/path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить контакт' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('корректный способ связи');
    expect(screen.getByLabelText('Имя контакта')).toHaveValue('Мастер Антон');

    fireEvent.change(screen.getByLabelText('Telegram'), { target: { value: '@anton_help' } });
    fireEvent.change(screen.getByLabelText('WhatsApp'), { target: { value: '+7 (999) 123-45-67' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить контакт' }));
    await waitFor(() => expect(screen.getByText('Мастер Антон')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Telegram Мастер Антон' })).toHaveAttribute('href', 'https://t.me/anton_help');
    expect(screen.getByRole('link', { name: 'WhatsApp Мастер Антон' })).toHaveAttribute('href', 'https://wa.me/79991234567');
  });

  it('supports roving keyboard focus and automatic activation for People tabs', () => {
    render(<WorkspaceProvider gateway={createDemoGateway(createDemoRepository({ loadPersisted: false }))}><PeopleWorkspace /></WorkspaceProvider>);
    const team = screen.getByRole('tab', { name: 'Команда' });
    const contacts = screen.getByRole('tab', { name: 'Контакты' });
    expect(team).toHaveAttribute('tabindex', '0');
    expect(contacts).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(team, { key: 'ArrowRight' });
    expect(contacts).toHaveFocus();
    expect(contacts).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(contacts, { key: 'Home' });
    expect(team).toHaveFocus();
    expect(team).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(team, { key: 'ArrowLeft' });
    expect(contacts).toHaveFocus();
    fireEvent.keyDown(contacts, { key: 'ArrowRight' });
    expect(team).toHaveFocus();
  });

  it('rebases a preserved contact draft onto actualVersion before retrying', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.updateContact = vi.fn(async (id, input, expectedVersion) => {
      if (expectedVersion === 1) throw new ConflictError(1, 2);
      return { ...gateway.snapshot().contacts.find((item) => item.id === id)!, ...input, version: 3, updatedAt: '2026-08-02T12:00:00.000Z' };
    });
    render(<WorkspaceProvider gateway={gateway}><PeopleWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Контакты' }));
    fireEvent.click(screen.getByRole('button', { name: 'Поставщик угля' }));
    fireEvent.change(screen.getByLabelText('Имя контакта'), { target: { value: 'Мой поставщик' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить контакт' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Черновик сохранён');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить контакт' }));
    await waitFor(() => expect(gateway.updateContact).toHaveBeenLastCalledWith(
      'contact-coal-supplier', expect.objectContaining({ name: 'Мой поставщик' }), 2,
    ));
    expect(screen.getByLabelText('Имя контакта')).toHaveValue('Мой поставщик');
  });

  it('shows restore failures after the contact form has closed', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.restoreContact = vi.fn().mockRejectedValue(new Error('Срок восстановления истёк'));
    render(<WorkspaceProvider gateway={gateway}><PeopleWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Контакты' }));
    fireEvent.click(screen.getByRole('button', { name: 'Поставщик угля' }));
    fireEvent.click(screen.getByRole('button', { name: 'Архивировать контакт' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Восстановить контакт' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Срок восстановления истёк');
  });

  it('consumes keyed contact navigation once, preserves drafts on refetch, and can reopen the same contact', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    const consumed = vi.fn();
    const rendered = render(<WorkspaceProvider gateway={gateway}><PeopleWorkspace onSearchTargetConsumed={consumed} searchTarget={{ id: 'contact-coal-supplier', requestKey: 1 }} /></WorkspaceProvider>);
    expect(await screen.findByLabelText('Имя контакта')).toHaveValue('Поставщик угля');
    expect(consumed).toHaveBeenCalledWith(1);
    fireEvent.change(screen.getByLabelText('Имя контакта'), { target: { value: 'Несохранённый контакт' } });
    await act(() => gateway.createContact({ name: 'Событие Realtime', methods: [{ kind: 'phone', value: '+79991112233' }] }));
    expect(screen.getByLabelText('Имя контакта')).toHaveValue('Несохранённый контакт');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть контакт' }));
    rendered.rerender(<WorkspaceProvider gateway={gateway}><PeopleWorkspace onSearchTargetConsumed={consumed} searchTarget={{ id: 'contact-coal-supplier', requestKey: 2 }} /></WorkspaceProvider>);
    await waitFor(() => expect(screen.getByLabelText('Имя контакта')).toHaveValue('Поставщик угля'));
  });

  it('closes a contact editor with Escape and restores focus to its opener', async () => {
    render(<WorkspaceProvider gateway={createDemoGateway(createDemoRepository({ loadPersisted: false }))}><PeopleWorkspace /></WorkspaceProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Контакты' }));
    const contact = screen.getByRole('button', { name: 'Поставщик угля' });
    contact.focus();
    fireEvent.click(contact);
    fireEvent.keyDown(screen.getByRole('form', { name: 'Контакт' }), { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Контакт' })).toBeNull();
    await waitFor(() => expect(contact).toHaveFocus());
  });
});
