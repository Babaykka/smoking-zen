'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createDemoRepository } from '@/data/demo-repository';
import type { WorkspaceRepository } from '@/data/workspace-repository';
import type { WorkspaceSnapshot } from '@/domain/types';

type WorkspaceProviderProps = {
  children: ReactNode;
  repository?: WorkspaceRepository;
};

export type WorkspaceContextValue = {
  repository: WorkspaceRepository;
  snapshot: WorkspaceSnapshot;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children, repository }: WorkspaceProviderProps) {
  const [defaultRepository] = useState<WorkspaceRepository>(() => createDemoRepository());
  const activeRepository = repository ?? defaultRepository;
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(() => activeRepository.snapshot());

  useEffect(() => {
    const unsubscribe = activeRepository.subscribe(setSnapshot);
    activeRepository.hydrate();
    return unsubscribe;
  }, [activeRepository]);

  const value = useMemo(() => ({ repository: activeRepository, snapshot }), [activeRepository, snapshot]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace must be used within WorkspaceProvider');

  return workspace;
}
