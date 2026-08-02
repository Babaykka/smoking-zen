'use client';

import { useEffect, useRef, useState } from 'react';

import type { SearchResult } from '@/domain/types';
import { useWorkspace } from '@/providers/workspace-provider';

const headings = { task: 'Задачи', knowledge: 'База знаний', contact: 'Контакты' } as const;

export function GlobalSearch({ onOpen }: { onOpen: (result: SearchResult) => void }) {
  const { repository } = useWorkspace();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState('');
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const timer = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); controller.current?.abort(); }, []);
  const search = (value: string) => {
    const request = ++generation.current;
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    controller.current?.abort();
    setQuery(value);
    const trimmed = value.trim();
    if (!trimmed) { setResults([]); setError(''); setActive(-1); return; }
    const nextController = new AbortController();
    controller.current = nextController;
    timer.current = window.setTimeout(() => {
      void repository.search(trimmed, { signal: nextController.signal }).then((next) => {
        if (request === generation.current) { setResults(next); setError(''); setActive(next.length ? 0 : -1); }
      }).catch((cause) => { if (request === generation.current && !(cause instanceof DOMException && cause.name === 'AbortError')) { setResults([]); setError('Не удалось выполнить поиск.'); } });
    }, 275);
  };
  const clear = () => search('');
  const open = (result: SearchResult) => { onOpen(result); clear(); };
  return <div className="global-search"><label>Поиск<input aria-activedescendant={active >= 0 && results[active] ? `search-result-${results[active].entity}-${results[active].id}` : undefined} aria-controls="search-results" aria-expanded={results.length > 0} aria-label="Поиск по штабу" onChange={(event) => search(event.target.value)} onKeyDown={(event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(results.length - 1, value + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
    if (event.key === 'Enter' && active >= 0 && results[active]) open(results[active]);
    if (event.key === 'Escape') { clear(); input.current?.blur(); }
  }} ref={input} role="combobox" value={query} /></label>{error && <p role="alert">{error}</p>}
    {!!results.length && <div aria-label="Результаты поиска" id="search-results" role="listbox">{(['task', 'knowledge', 'contact'] as const).map((entity) => { const group = results.filter((result) => result.entity === entity); const headingId = `search-heading-${entity}`; return group.length ? <section aria-labelledby={headingId} key={entity} role="group"><h2 id={headingId}>{headings[entity]}</h2>{group.map((result) => <button aria-selected={results.indexOf(result) === active} id={`search-result-${result.entity}-${result.id}`} key={`${result.entity}-${result.id}`} onClick={() => open(result)} role="option" type="button">{result.title}</button>)}</section> : null; })}</div>}</div>;
}
