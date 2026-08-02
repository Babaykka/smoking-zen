'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { WorkspaceGateway } from '@/data/workspace-gateway';
import type { WorkspaceSnapshot } from '@/domain/types';

type WorkspaceProviderProps = {
  children: ReactNode;
  gateway: WorkspaceGateway;
};

export type WorkspaceContextValue = {
  repository: WorkspaceGateway;
  snapshot: WorkspaceSnapshot;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children, gateway }: WorkspaceProviderProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(() => gateway.snapshot());

  useEffect(() => {
    const unsubscribe = gateway.subscribe(setSnapshot);
    void gateway.hydrate();
    return unsubscribe;
  }, [gateway]);

  const value = useMemo(() => ({ repository: gateway, snapshot }), [gateway, snapshot]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace must be used within WorkspaceProvider');

  return workspace;
}
