import { BookOpen, CheckSquare, House, UsersRound } from 'lucide-react';

export type ViewKey = 'today' | 'tasks' | 'knowledge' | 'people';

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
    </nav>
  );
}
