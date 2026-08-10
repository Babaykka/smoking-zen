import type { WorkspaceRepository, WorkspaceListener } from '@/data/workspace-repository';
import { validateUpload, type AttachmentTarget, type SignedAttachmentDownload } from '@/domain/files';
import type { CommentInput, ContactInput, ContactPatchInput, KnowledgeInput, KnowledgePatchInput, SecureItemInput, SecureItemPatchInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { Attachment, Comment, Contact, InviteGrant, KnowledgeItem, SearchResult, SecureItemReveal, SecureItemSummary, Task, TrashItem, WorkspaceSnapshot } from '@/domain/types';

export interface WorkspaceGateway {
  fileStorageMode: 'persistent' | 'metadata-only';
  snapshot(): WorkspaceSnapshot;
  hydrate(): Promise<void>;
  refresh(): Promise<WorkspaceSnapshot>;
  subscribe(listener: WorkspaceListener): () => void;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, input: TaskPatchInput, expectedVersion: number): Promise<Task>;
  deleteTask(id: string, expectedVersion: number): Promise<Task>;
  restoreTask(id: string, expectedVersion: number): Promise<Task>;
  createComment(input: CommentInput): Promise<Comment>;
  createKnowledge(input: KnowledgeInput): Promise<KnowledgeItem>;
  updateKnowledge(id: string, input: KnowledgePatchInput, expectedVersion: number): Promise<KnowledgeItem>;
  deleteKnowledge(id: string, expectedVersion: number): Promise<KnowledgeItem>;
  restoreKnowledge(id: string, expectedVersion: number): Promise<KnowledgeItem>;
  createContact(input: ContactInput): Promise<Contact>;
  updateContact(id: string, input: ContactPatchInput, expectedVersion: number): Promise<Contact>;
  deleteContact(id: string, expectedVersion: number): Promise<Contact>;
  restoreContact(id: string, expectedVersion: number): Promise<Contact>;
  createInvite(): Promise<InviteGrant>;
  createSecureItem(input: SecureItemInput): Promise<SecureItemSummary>;
  updateSecureItem(id: string, input: SecureItemPatchInput, expectedVersion: number): Promise<SecureItemSummary>;
  deleteSecureItem(id: string, expectedVersion: number): Promise<SecureItemSummary>;
  restoreSecureItem(id: string, expectedVersion: number): Promise<SecureItemSummary>;
  revealSecureItem(id: string): Promise<SecureItemReveal>;
  uploadAttachment(target: AttachmentTarget, file: File, onProgress?: (percent: number) => void): Promise<Attachment>;
  downloadAttachment(id: string): Promise<SignedAttachmentDownload>;
  deleteAttachment(id: string, expectedVersion: number): Promise<TrashItem>;
  restoreAttachment(id: string, expectedVersion: number): Promise<Attachment>;
  search(query: string, options?: { signal?: AbortSignal }): Promise<SearchResult[]>;
  dispose?(): void;
}

export function createDemoGateway(repository: WorkspaceRepository): WorkspaceGateway {
  return {
    fileStorageMode: 'metadata-only',
    snapshot: () => repository.snapshot(),
    async hydrate() { repository.hydrate(); },
    async refresh() {
      repository.hydrate();
      return repository.snapshot();
    },
    subscribe: (listener) => repository.subscribe(listener),
    async createTask(input) { return repository.createTask(input); },
    async updateTask(id, input, expectedVersion) { return repository.updateTask(id, input, expectedVersion); },
    async deleteTask(id, expectedVersion) { return repository.deleteTask(id, expectedVersion); },
    async restoreTask(id, expectedVersion) { return repository.restore('task', id, expectedVersion) as Task; },
    async createComment(input) { return repository.createComment(input); },
    async createKnowledge(input) { return repository.createKnowledge(input); },
    async updateKnowledge(id, input, expectedVersion) { return repository.updateKnowledge(id, input, expectedVersion); },
    async deleteKnowledge(id, expectedVersion) { return repository.deleteKnowledge(id, expectedVersion); },
    async restoreKnowledge(id, expectedVersion) { return repository.restore('knowledge', id, expectedVersion) as KnowledgeItem; },
    async createContact(input) { return repository.createContact(input); },
    async updateContact(id, input, expectedVersion) { return repository.updateContact(id, input, expectedVersion); },
    async deleteContact(id, expectedVersion) { return repository.deleteContact(id, expectedVersion); },
    async restoreContact(id, expectedVersion) { return repository.restore('contact', id, expectedVersion) as Contact; },
    async createInvite() {
      const demoToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '').slice(0, 43);
      return {
        invitationId: crypto.randomUUID(),
        inviteLink: `https://t.me/smoking_zen_demo/workspace?startapp=invite_${demoToken}`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      };
    },
    async createSecureItem(input) { return repository.createSecureItem(input); },
    async updateSecureItem(id, input, expectedVersion) { return repository.updateSecureItem(id, input, expectedVersion); },
    async deleteSecureItem(id, expectedVersion) { return repository.deleteSecureItem(id, expectedVersion); },
    async restoreSecureItem(id, expectedVersion) { return repository.restore('secureItem', id, expectedVersion) as SecureItemSummary; },
    async revealSecureItem(id) { return repository.revealSecureItem(id); },
    async uploadAttachment(target, file, onProgress) {
      onProgress?.(10);
      const headerBytes = new Uint8Array(await file.slice(0, 8_192).arrayBuffer());
      const validated = validateUpload({ name: file.name, declaredMime: file.type, size: file.size, headerBytes });
      onProgress?.(70);
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        name: validated.name,
        mimeType: validated.declaredMime,
        size: validated.size,
        version: 1,
      };
      if (target.type === 'task') {
        const current = repository.snapshot().tasks.find((item) => item.id === target.id);
        if (!current) throw new Error('Задача для вложения не найдена.');
        repository.updateTask(target.id, { attachments: [...current.attachments, attachment] }, current.version);
      } else {
        const current = repository.snapshot().knowledge.find((item) => item.id === target.id);
        if (!current) throw new Error('Материал для вложения не найден.');
        repository.updateKnowledge(target.id, { attachments: [...current.attachments, attachment] }, current.version);
      }
      onProgress?.(100);
      return attachment;
    },
    async downloadAttachment() { throw new Error('В демо-режиме сохраняются только данные о файле, без его содержимого.'); },
    async deleteAttachment(id, expectedVersion) { return repository.deleteAttachment(id, expectedVersion); },
    async restoreAttachment(id, expectedVersion) { return repository.restoreAttachment(id, expectedVersion); },
    async search(query) { return repository.search(query); },
  };
}
