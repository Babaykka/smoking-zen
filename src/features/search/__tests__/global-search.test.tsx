import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import type { SearchResult } from '@/domain/types';
import { GlobalSearch } from '@/features/search/global-search';
import { WorkspaceProvider } from '@/providers/workspace-provider';

afterEach(() => vi.useRealTimers());

describe('GlobalSearch', () => {
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
});
