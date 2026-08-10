import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

  it('shows a direct desktop Safe entry while mobile keeps Safe under “Ещё”', async () => {
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
    expect(within(mobile as HTMLElement).getByRole('menuitem', { name: 'Корзина' })).toBeInTheDocument();
    fireEvent.keyDown(within(mobile as HTMLElement).getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(mobileMore).toHaveFocus());
    fireEvent.click(desktopSafe);
    expect(navigate).toHaveBeenCalledWith('safe');
  });

  it('marks “Ещё” active for Trash and restores its focus when Escape closes the menu', async () => {
    const { container } = render(<AppShell activeView="trash" onNavigate={() => {}} onCreate={() => {}}><p>Содержимое</p></AppShell>);
    const mobile = container.querySelector('.navigation--bottom') as HTMLElement;
    const more = within(mobile).getByRole('button', { name: 'Ещё' });
    expect(more).toHaveClass('navigation__link--active');
    expect(more).toHaveAttribute('aria-current', 'page');
    fireEvent.click(more);
    expect(within(mobile).getByRole('menuitem', { name: 'Сейф' })).toHaveFocus();
    fireEvent.keyDown(within(mobile).getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(more).toHaveFocus());
  });

  it('provides wrapping menu keyboard navigation and activates the focused destination', async () => {
    const navigate = vi.fn();
    const { container } = render(<AppShell activeView="today" onNavigate={navigate} onCreate={() => {}}><p>Содержимое</p></AppShell>);
    const mobile = container.querySelector('.navigation--bottom') as HTMLElement;
    const more = within(mobile).getByRole('button', { name: 'Ещё' });
    fireEvent.click(more);
    const menu = within(mobile).getByRole('menu');
    const safe = within(menu).getByRole('menuitem', { name: 'Сейф' });
    const trash = within(menu).getByRole('menuitem', { name: 'Корзина' });

    expect(safe).toHaveFocus();
    fireEvent.keyDown(safe, { key: 'ArrowDown' });
    expect(trash).toHaveFocus();
    fireEvent.keyDown(trash, { key: 'ArrowDown' });
    expect(safe).toHaveFocus();
    fireEvent.keyDown(safe, { key: 'ArrowUp' });
    expect(trash).toHaveFocus();
    fireEvent.keyDown(trash, { key: 'Home' });
    expect(safe).toHaveFocus();
    fireEvent.keyDown(safe, { key: 'End' });
    expect(trash).toHaveFocus();
    fireEvent.keyDown(trash, { key: 'Enter' });

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('trash');
    expect(menu).toHaveAttribute('hidden');
  });
});
