// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { createDemoRepository } from '@/data/demo-repository';
import { createDemoGateway } from '@/data/workspace-gateway';
import type { WorkspacePersistence } from '@/data/workspace-repository';

describe('demo secure items', () => {
  it('keeps reveal URLs in memory while persisting and publishing summaries only', () => {
    const writes: unknown[] = [];
    const persistence: WorkspacePersistence = {
      load: () => null,
      save: (snapshot) => writes.push(structuredClone(snapshot)),
    };
    const repository = createDemoRepository({ persistence, loadPersisted: false });
    const externalUrl = 'https://vault.bitwarden.com/#/items/memory-only';

    const created = repository.createSecureItem({
      title: 'Касса',
      purpose: 'Операционная касса',
      owner: 'Управляющий',
      reviewDate: null,
      cardBank: 'Банк',
      cardHolder: 'SMOKING ZEN',
      cardPurpose: 'Расходы',
      lastFour: '4242',
      externalUrl,
    });

    expect(created).not.toHaveProperty('externalUrl');
    const summary = repository.snapshot().secureItems.find((item) => item.id === created.id);
    expect(summary).toMatchObject({ title: 'Касса', lastFour: '4242' });
    expect(summary).not.toHaveProperty('externalUrl');
    expect(JSON.stringify(writes)).not.toContain(externalUrl);
    expect(repository.revealSecureItem(created.id)).toEqual({ externalUrl });
  });

  it('uses a blank URL replacement without placing the previous URL in the patchable summary', () => {
    const repository = createDemoRepository({ loadPersisted: false });
    const created = repository.createSecureItem({
      title: 'Касса', purpose: 'Доступ', owner: 'Владелец', externalUrl: 'https://vault.bitwarden.com/#/items/old',
    });
    const updated = repository.updateSecureItem(created.id, {
      owner: 'Управляющий', externalUrl: 'https://vault.bitwarden.eu/#/items/new',
    }, created.version);

    expect(updated).toMatchObject({ owner: 'Управляющий', version: 2 });
    expect(updated).not.toHaveProperty('externalUrl');
    expect(repository.revealSecureItem(created.id)).toEqual({ externalUrl: 'https://vault.bitwarden.eu/#/items/new' });
  });
});

describe('demo private files', () => {
  it('persists only attachment metadata and never file bytes or a signed URL', async () => {
    const writes: unknown[] = [];
    const persistence: WorkspacePersistence = {
      load: () => null,
      save: (snapshot) => writes.push(structuredClone(snapshot)),
    };
    const repository = createDemoRepository({ persistence, loadPersisted: false });
    const gateway = createDemoGateway(repository);
    const task = repository.snapshot().tasks[0]!;
    const fileContents = 'memory-only-file-contents';
    const file = new File([fileContents], 'policy.txt', { type: 'text/plain' });

    const attachment = await gateway.uploadAttachment({ type: 'task', id: task.id }, file);

    expect(attachment).toMatchObject({ name: 'policy.txt', mimeType: 'text/plain', size: file.size });
    expect(attachment).not.toHaveProperty('storagePath');
    expect(repository.snapshot().tasks[0]!.attachments).toContainEqual(attachment);
    expect(JSON.stringify(writes)).not.toMatch(/memory-only-file-contents|signedUrl|uploadUrl|storagePath/iu);
    await expect(gateway.downloadAttachment(attachment.id)).rejects.toThrow('без его содержимого');
  });
});
