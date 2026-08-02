import { expect, test } from '@playwright/test';

test('creates knowledge and contacts, then opens task, knowledge and contact from search', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'База' }).first().click();
  await page.getByRole('button', { name: 'Добавить материал' }).click();
  await page.getByLabel('Название материала').fill('Регламент витрины');
  await page.getByLabel('Содержание').fill('- [x] Проверить чистоту');
  await page.getByRole('button', { name: 'Сохранить материал' }).click();
  await expect(page.getByText('Регламент витрины')).toBeVisible();

  await page.getByRole('link', { name: 'Люди' }).first().click();
  await page.getByRole('tab', { name: 'Контакты' }).click();
  await page.getByRole('button', { name: 'Добавить контакт' }).click();
  await page.getByLabel('Имя контакта').fill('Мастер Антон');
  await page.getByLabel('Telegram').fill('@anton_help');
  await page.getByRole('button', { name: 'Сохранить контакт' }).click();
  await expect(page.getByRole('link', { name: 'Telegram Мастер Антон' })).toHaveAttribute('href', 'https://t.me/anton_help');

  const search = page.getByRole('combobox', { name: 'Поиск по штабу' });
  await search.fill('КОКОС');
  await expect(page.getByRole('option', { name: 'Проверить запас кокосового угля' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Название')).toHaveValue('Проверить запас кокосового угля');

  await search.fill('Регламент витрины');
  await expect(page.getByRole('option', { name: 'Регламент витрины' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Название материала')).toHaveValue('Регламент витрины');

  await search.fill('Мастер Антон');
  await expect(page.getByRole('option', { name: 'Мастер Антон' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Имя контакта')).toHaveValue('Мастер Антон');
});

test('knowledge and people remain reachable without horizontal overflow at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await page.getByRole('link', { name: 'База' }).last().click();
  await expect(page.getByRole('heading', { name: 'База знаний' })).toBeVisible();
  await page.getByRole('link', { name: 'Люди' }).last().click();
  await expect(page.getByRole('tab', { name: 'Команда' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
