import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import type { SearchResult } from '@/domain/types';
import { GlobalSearch } from '@/features/search/global-search';
import { WorkspaceProvider } from '@/providers/workspace-provider';

afterEach(() => vi.useRealTimers());

describe('GlobalSearch', () => {
  it('focuses the command search with either platform shortcut and clears it with Escape', () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    render(<WorkspaceProvider gateway={gateway}><GlobalSearch onOpen={() => {}} /></WorkspaceProvider>);
    const input = screen.getByRole('combobox', { name: 'Поиск по штабу' });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'уголь' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue('');
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(input).toHaveFocus();
  });

  it('finds an active Cyrillic task after the debounce', async () => {
    vi.useFakeTimers();
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    await expect(gateway.search('КОКОС')).resolves.toEqual([{ entity: 'task', id: 'task-check-coals', title: 'Проверить запас кокосового угля' }]);
    render(<WorkspaceProvider gateway={gateway}><GlobalSearch onOpen={() => {}} /></WorkspaceProvider>);
    fireEvent.change(screen.getByRole('combobox', { name: 'Поиск по штабу' }), { target: { value: 'КОКОС' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(275); });
    await act(async () => {});
    expect(screen.getByRole('option', { name: 'Проверить запас кокосового угля' })).toBeInTheDocument();
  });

  it('never persists or returns an unsafe URL sentinel through search', async () => {
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    const sentinel = 'SIGNED_URL_SEARCH_SENTINEL';

    await expect(gateway.createTask({
      title: 'Небезопасная ссылка',
      description: `https://example.com/guide?lang=${sentinel}`,
    })).rejects.toThrow();
    await expect(gateway.search(sentinel)).resolves.toEqual([]);
  });

  it('debounces and ignores a stale response after the query is cleared', async () => {
    vi.useFakeTimers();
    let resolveSearch: ((value: SearchResult[]) => void) | undefined;
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.search = vi.fn(() => new Promise<SearchResult[]>((resolve) => { resolveSearch = resolve; }));
    render(<WorkspaceProvider gateway={gateway}><GlobalSearch onOpen={() => {}} /></WorkspaceProvider>);

    fireEvent.change(screen.getByRole('combobox', { name: 'Поиск по штабу' }), { target: { value: 'уголь' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(275); });
    fireEvent.change(screen.getByRole('combobox', { name: 'Поиск по штабу' }), { target: { value: '' } });
    await act(async () => { resolveSearch?.([{ entity: 'task', id: 'task-1', title: 'Старая выдача' }]); });

    expect(screen.queryByText('Старая выдача')).toBeNull();
  });

  it('uses keyboard navigation through grouped results and exposes styled combobox semantics', async () => {
    vi.useFakeTimers();
    const gateway = createDemoGateway(createDemoRepository({ loadPersisted: false }));
    gateway.search = vi.fn().mockResolvedValue([
      { entity: 'task', id: 'task-1', title: 'Задача' },
      { entity: 'knowledge', id: 'knowledge-1', title: 'Материал' },
    ]);
    const open = vi.fn();
    render(<WorkspaceProvider gateway={gateway}><GlobalSearch onOpen={open} /></WorkspaceProvider>);
    const input = screen.getByRole('combobox', { name: 'Поиск по штабу' });
    expect(input).toHaveClass('global-search__input');
    fireEvent.change(input, { target: { value: 'поиск' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(275); });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(open).toHaveBeenCalledWith({ entity: 'knowledge', id: 'knowledge-1', title: 'Материал' });
  });
});
