import { expect, test } from '@playwright/test';

test('shows the workspace shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Сегодня' }).first()).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: 'Создать задачу' }).first()).toBeVisible();
  await expect(page.getByText('Демо-режим: рабочие данные не подключены.')).toBeVisible();
});
