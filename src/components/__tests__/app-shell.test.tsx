import { fireEvent, render, screen, within } from '@testing-library/react';

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

  it('shows a direct desktop Safe entry while mobile keeps Safe under “Ещё”', () => {
    const navigate = vi.fn();
    const { container } = render(<AppShell activeView="today" onNavigate={navigate} onCreate={() => {}}><p>Содержимое</p></AppShell>);
    const desktop = container.querySelector('.navigation--sidebar')!;
    const mobile = container.querySelector('.navigation--bottom')!;

    const desktopSafe = within(desktop as HTMLElement).getByRole('link', { name: 'Сейф' });
    expect(within(desktop as HTMLElement).queryByRole('button', { name: 'Ещё' })).not.toBeInTheDocument();
    expect(within(mobile as HTMLElement).queryByRole('link', { name: 'Сейф' })).not.toBeInTheDocument();
    const mobileMore = within(mobile as HTMLElement).getByRole('button', { name: 'Ещё' });
    const collapsedMenu = within(mobile as HTMLElement).getByRole('menu', { hidden: true });
    expect(collapsedMenu).toHaveAttribute('hidden');
    expect(collapsedMenu).toHaveAttribute('inert');
    expect(within(mobile as HTMLElement).queryByRole('menuitem', { name: 'Сейф' })).not.toBeInTheDocument();
    fireEvent.click(mobileMore);
    expect(within(mobile as HTMLElement).getByRole('menuitem', { name: 'Сейф' })).toBeInTheDocument();
    fireEvent.click(desktopSafe);
    expect(navigate).toHaveBeenCalledWith('safe');
  });
});
