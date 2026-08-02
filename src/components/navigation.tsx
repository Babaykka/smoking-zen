'use client';

import { BookOpen, CheckSquare, Ellipsis, House, ShieldCheck, UsersRound } from 'lucide-react';
import { useState } from 'react';

export type ViewKey = 'today' | 'tasks' | 'knowledge' | 'people' | 'safe';

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

  return (
    <nav aria-label="Основная навигация" className={`navigation navigation--${variant}`}>
      {navigationItems.map(({ icon: Icon, key, label }) => {
        const isActive = key === activeView;
        return (
          <a
            aria-current={isActive ? 'page' : undefined}
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
        <a
          aria-current={activeView === 'safe' ? 'page' : undefined}
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
      ) : <div className="navigation__secondary">
        <button
          aria-expanded={secondaryOpen}
          aria-haspopup="menu"
          className={activeView === 'safe' ? 'navigation__link navigation__link--active' : 'navigation__link'}
          onClick={() => setSecondaryOpen((current) => !current)}
          type="button"
        >
          <Ellipsis aria-hidden="true" size={20} strokeWidth={1.8} />
          <span>Ещё</span>
        </button>
        <div className="navigation__secondary-menu" hidden={!secondaryOpen} inert={!secondaryOpen ? true : undefined} role="menu">
          <a
            aria-current={activeView === 'safe' ? 'page' : undefined}
            className={activeView === 'safe' ? 'navigation__link navigation__link--active' : 'navigation__link'}
            href="#safe"
            onClick={(event) => {
              event.preventDefault();
              setSecondaryOpen(false);
              onNavigate('safe');
            }}
            role="menuitem"
          >
            <ShieldCheck aria-hidden="true" size={20} strokeWidth={1.8} />
            <span>Сейф</span>
          </a>
        </div>
      </div>}
    </nav>
  );
}
