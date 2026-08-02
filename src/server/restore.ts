import {
  RestoreExpiredError,
  RestoreNotDeletedError,
  RestoreNotFoundError,
} from '@/data/workspace-repository';

export type DatabaseError = { code?: string; message?: string } | null;

export function isDatabaseVersionConflict(error: DatabaseError): boolean {
  return error?.code === '40001' && error.message === 'version_conflict';
}

export function throwKnownRestoreDatabaseError(error: DatabaseError, notFoundMessage: string): void {
  if (error?.code === 'P0002' && error.message === notFoundMessage) throw new RestoreNotFoundError();
  if (error?.code === '55000' && error.message === 'restore_not_deleted') throw new RestoreNotDeletedError();
  if (error?.code === '22023' && error.message === 'restore_expired') throw new RestoreExpiredError();
}
