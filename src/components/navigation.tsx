'use client';

import { BookOpen, CheckSquare, Ellipsis, House, ShieldCheck, Trash2, UsersRound } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type ViewKey = 'today' | 'tasks' | 'knowledge' | 'people' | 'safe' | 'trash';

type NavigationProps = {
  activeView: ViewKey;
  onNavigate: (view: ViewKey) => void;
  variant: 'sidebar' | 'bottom';
};

const navigationItems = [
  { key: 'today' as const, label: 'Сегодня', icon: House },
  { key: 'tasks' as const, label: 'Задачи', icon: CheckSquare },
  { key: 'knowledge' as const, label: 'База', icon: BookOpen },
  { key: 'people' as const, label: 'Люди', icon: UsersRound },
];

export function Navigation({ activeView, onNavigate, variant }: NavigationProps) {
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (secondaryOpen) firstMenuItemRef.current?.focus();
  }, [secondaryOpen]);

  const closeSecondary = (restoreFocus: boolean) => {
    setSecondaryOpen(false);
    if (restoreFocus) window.setTimeout(() => moreButtonRef.current?.focus(), 0);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSecondary(true);
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (!items.length) return;
    const activeIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus();
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.matches('[role="menuitem"]')) {
      event.preventDefault();
      event.target.click();
    }
  };

  return (
    <nav aria-label="Основная навигация" className={`navigation navigation--${variant}`}>
      {navigationItems.map(({ icon: Icon, key, label }) => {
        const isActive = key === activeView;
        return (
          <a
            aria-current={isActive ? 'page' : undefined}
            aria-label={label}
            className={isActive ? 'navigation__link navigation__link--active' : 'navigation__link'}
            href={`#${key}`}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(key);
            }}
          >
            <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>{label}</span>
          </a>
        );
      })}
      {variant === 'sidebar' ? (
        <>
          <a
            aria-current={activeView === 'safe' ? 'page' : undefined}
            aria-label="Сейф"
            className={activeView === 'safe' ? 'navigation__link navigation__link--active' : 'navigation__link'}
            href="#safe"
            onClick={(event) => {
              event.preventDefault();
              onNavigate('safe');
            }}
          >
            <ShieldCheck aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>Сейф</span>
          </a>
          <a
            aria-current={activeView === 'trash' ? 'page' : undefined}
            aria-label="Корзина"
            className={activeView === 'trash' ? 'navigation__link navigation__link--active' : 'navigation__link'}
            href="#trash"
            onClick={(event) => {
              event.preventDefault();
              onNavigate('trash');
            }}
          >
            <Trash2 aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>Корзина</span>
          </a>
        </>
      ) : <div className="navigation__secondary">
        <button
          aria-current={activeView === 'safe' || activeView === 'trash' ? 'page' : undefined}
          aria-expanded={secondaryOpen}
          aria-haspopup="menu"
          aria-label="Ещё"
          className={activeView === 'safe' || activeView === 'trash' ? 'navigation__link navigation__link--active' : 'navigation__link'}
          onClick={() => setSecondaryOpen((current) => !current)}
          ref={moreButtonRef}
          type="button"
        >
          <Ellipsis aria-hidden="true" size={20} strokeWidth={1.8} />
          <span>Ещё</span>
        </button>
        <div className="navigation__secondary-menu" hidden={!secondaryOpen} inert={!secondaryOpen ? true : undefined} onKeyDown={onMenuKeyDown} role="menu">
          <a
            aria-current={activeView === 'safe' ? 'page' : undefined}
            aria-label="Сейф"
            className={activeView === 'safe' ? 'navigation__link navigation__link--active' : 'navigation__link'}
            href="#safe"
            onClick={(event) => {
              event.preventDefault();
              closeSecondary(false);
              onNavigate('safe');
            }}
            ref={firstMenuItemRef}
            role="menuitem"
          >
            <ShieldCheck aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>Сейф</span>
          </a>
          <a
            aria-current={activeView === 'trash' ? 'page' : undefined}
            aria-label="Корзина"
            className={activeView === 'trash' ? 'navigation__link navigation__link--active' : 'navigation__link'}
            href="#trash"
            onClick={(event) => {
              event.preventDefault();
              closeSecondary(false);
              onNavigate('trash');
            }}
            role="menuitem"
          >
            <Trash2 aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>Корзина</span>
          </a>
        </div>
      </div>}
    </nav>
  );
}
