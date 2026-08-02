import { fireEvent, render, screen } from '@testing-library/react';

import { AppShell } from '@/components/app-shell';

describe('AppShell', () => {
  it('renders the Russian navigation labels and marks the current page', () => {
    render(
      <AppShell activeView="today" onNavigate={() => {}} onCreate={() => {}}>
        <p>Содержимое</p>
      </AppShell>,
    );

    for (const link of screen.getAllByRole('link', { name: 'Сегодня' })) {
      expect(link).toHaveAttribute('aria-current', 'page');
    }
    for (const link of screen.getAllByRole('link', { name: 'Задачи' })) {
      expect(link).not.toHaveAttribute('aria-current');
    }
    expect(screen.getAllByRole('link', { name: 'База' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Люди' })).toHaveLength(2);
  });

  it('exposes an accessible global create button', () => {
    render(
      <AppShell activeView="today" onNavigate={() => {}} onCreate={() => {}}>
        <p>Содержимое</p>
      </AppShell>,
    );

    expect(screen.getAllByRole('button', { name: 'Создать задачу' })).toHaveLength(2);
  });

  it('places Safe under the secondary navigation instead of the primary destinations', () => {
    const navigate = vi.fn();
    render(<AppShell activeView="today" onNavigate={navigate} onCreate={() => {}}><p>Содержимое</p></AppShell>);
    for (const trigger of screen.getAllByText('Ещё')) fireEvent.click(trigger);
    const links = screen.getAllByRole('menuitem', { name: 'Сейф' });
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]!);
    expect(navigate).toHaveBeenCalledWith('safe');
  });
});
