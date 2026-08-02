import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import { contactMethodHref, PeopleWorkspace } from '@/features/people/people-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

describe('PeopleWorkspace', () => {
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
});
