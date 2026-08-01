import { expect, test } from '@playwright/test';

test('creates and edits a task in the demo workspace', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).first().click();
  await page.getByLabel('Название задачи').fill('Подготовить VIP-зону');
  await page.getByRole('button', { name: 'Добавить' }).click();

  await expect(page.getByText('Подготовить VIP-зону')).toBeVisible();
  await page.getByRole('link', { name: 'Задачи' }).first().click();
  await page.getByRole('button', { name: 'Открыть задачу Подготовить VIP-зону' }).click();
  await page.getByLabel('Приоритет').selectOption('1');
  await page.getByLabel('Статус').selectOption('status-in-progress');
  await page.getByRole('button', { name: 'Сохранить задачу' }).click();

  await expect(page.getByRole('region', { name: 'Предпросмотр описания' })).toBeVisible();
  await expect(page.getByLabel('Приоритет')).toHaveValue('1');
});
