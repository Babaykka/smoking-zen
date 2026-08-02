import { expect, test } from '@playwright/test';

test('adds metadata-only demo attachments with progress and recovery-safe download behavior', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Задачи' }).first().click();
  await page.getByRole('button', { name: 'Открыть задачу Проверить запас кокосового угля' }).click();

  const picker = page.getByLabel('Добавить файл');
  await expect(picker).toHaveAttribute('accept', '.jpg,.jpeg,.png,.webp,.pdf,.txt,.docx,.xlsx');
  await picker.setInputFiles({
    name: 'unsafe.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
  });
  await expect(page.locator('.attachment-widget').getByRole('alert')).toContainText('Разрешены только JPEG');
  await expect(page.getByRole('button', { name: 'Повторить загрузку' })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(page.locator('.attachment-widget').getByRole('alert')).toContainText('Разрешены только JPEG');
  await expect(page.getByRole('button', { name: 'Скачать unsafe.svg' })).toHaveCount(0);

  const validPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await picker.setInputFiles({
    name: 'private-photo.png',
    mimeType: 'image/png',
    buffer: validPng,
  });

  await expect(page.locator('.attachment-widget__status')).toContainText('Файл private-photo.png добавлен.');
  await expect(page.getByText('private-photo.png', { exact: true })).toBeVisible();
  const persisted = await page.evaluate(() => Object.values(localStorage).join('\n'));
  expect(persisted).not.toMatch(/<svg|alert\(1\)|signedurl|uploadurl|storagepath/iu);

  await page.getByRole('button', { name: 'Скачать private-photo.png' }).click();
  await expect(page.locator('.attachment-widget').getByRole('alert')).toContainText('без его содержимого');
});

test('keeps Safe summaries masked and reveals an allowed Bitwarden URL only after an explicit action', async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    Object.defineProperty(window, '__openedSafeUrls', { value: opened, configurable: true });
    window.open = ((url?: string | URL) => {
      if (url) opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto('/');

  const navigation = page.locator('.navigation:visible');
  await navigation.getByRole('button', { name: 'Ещё' }).click();
  await navigation.getByRole('menuitem', { name: 'Сейф' }).click();
  await expect(page.getByRole('heading', { name: 'Сейф' })).toBeVisible();
  await expect(page.getByText('•••• 0000')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __openedSafeUrls?: string[] }).__openedSafeUrls)).toEqual([]);

  await page.getByRole('button', { name: 'Добавить запись' }).click();
  await page.getByLabel('Название записи').fill('Резервный терминал');
  await page.getByLabel('Назначение', { exact: true }).fill('Оплата поставщикам');
  await page.getByLabel('Ответственный').fill('Управляющий');
  await page.getByLabel('Банк').fill('Тестовый банк');
  await page.getByLabel('Последние четыре цифры').fill('4242');
  const externalUrl = 'https://vault.bitwarden.eu/#/items/e2e-memory-only';
  await page.getByLabel('Ссылка Bitwarden').fill(externalUrl);
  await page.getByRole('button', { name: 'Сохранить запись' }).click();

  await expect(page.getByRole('heading', { name: 'Резервный терминал' })).toBeVisible();
  await expect(page.getByText('•••• 4242')).toBeVisible();
  expect(await page.locator('body').innerHTML()).not.toContain(externalUrl);
  expect(await page.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain(externalUrl);
  expect(await page.evaluate(() => (window as typeof window & { __openedSafeUrls?: string[] }).__openedSafeUrls)).toEqual([]);

  await page.getByRole('button', { name: 'Открыть Bitwarden для Резервный терминал' }).click();
  expect(await page.evaluate(() => (window as typeof window & { __openedSafeUrls?: string[] }).__openedSafeUrls)).toEqual([externalUrl]);

  await page.getByRole('button', { name: 'Изменить Резервный терминал' }).click();
  await page.getByRole('button', { name: 'Архивировать' }).click();
  await expect(page.getByRole('button', { name: 'Восстановить запись' })).toBeVisible();
  await page.getByRole('button', { name: 'Восстановить запись' }).click();
  await expect(page.getByRole('heading', { name: 'Резервный терминал' })).toBeVisible();

  const search = page.getByRole('combobox', { name: 'Поиск по штабу' });
  await search.fill('Резервный терминал');
  await expect(page.getByRole('option', { name: 'Резервный терминал' })).toHaveCount(0);
});

test('keeps the secondary Safe flow and file picker inside an exact 360px viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One exact-width visual assertion is sufficient.');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  expect(await page.evaluate(() => window.innerWidth)).toBe(360);

  const navigation = page.locator('.navigation--bottom');
  await expect(navigation).toBeVisible();
  await expect(navigation.locator(':scope > .navigation__link, :scope > .navigation__secondary > .navigation__link').allTextContents())
    .resolves.toEqual(['Сегодня', 'Задачи', 'База', 'Люди', 'Ещё']);
  await navigation.getByRole('button', { name: 'Ещё' }).click();
  await navigation.getByRole('menuitem', { name: 'Сейф' }).click();
  await page.getByRole('button', { name: 'Добавить запись' }).click();

  const editor = page.getByRole('complementary', { name: 'Безопасная запись' });
  const editorBox = await editor.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.x).toBeGreaterThanOrEqual(0);
  expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'Закрыть' }).click();
  await navigation.getByRole('link', { name: 'Задачи' }).click();
  await page.getByRole('button', { name: 'Открыть задачу Проверить запас кокосового угля' }).click();
  const pickerBox = await page.getByText('Добавить файл', { exact: true }).boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
