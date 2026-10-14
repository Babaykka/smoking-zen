import { expect, test } from '@playwright/test';

test('creates knowledge and contacts, then opens task, knowledge and contact from search', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'База' }).first().click();
  await page.getByRole('button', { name: 'Добавить материал' }).click();
  await page.getByLabel('Название материала').fill('Регламент витрины');
  await page.getByLabel('Содержание').fill('- [x] Проверить чистоту');
  await page.getByRole('button', { name: 'Сохранить материал' }).click();
  await expect(page.getByLabel('Название материала')).toHaveValue('Регламент витрины');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByText('Регламент витрины')).toBeVisible();

  await page.getByRole('link', { name: 'Люди' }).first().click();
  await page.getByRole('tab', { name: 'Контакты' }).click();
  await page.getByRole('button', { name: 'Добавить контакт' }).click();
  await page.getByLabel('Имя контакта').fill('Контакт мастера');
  await page.getByLabel('Telegram').fill('@contact_one_help');
  await page.getByRole('button', { name: 'Сохранить контакт' }).click();
  await expect(page.getByRole('link', { name: 'Telegram Контакт мастера' })).toHaveAttribute('href', 'https://t.me/contact_one_help');

  const search = page.getByRole('combobox', { name: 'Поиск по штабу' });
  await search.fill('КОКОС');
  await expect(page.getByRole('option', { name: 'Проверить запас кокосового угля' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Название')).toHaveValue('Проверить запас кокосового угля');

  await search.fill('Регламент витрины');
  await expect(page.getByRole('option', { name: 'Регламент витрины' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Название материала')).toHaveValue('Регламент витрины');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('link', { name: 'Люди' }).first().click();
  await page.getByRole('link', { name: 'База' }).first().click();
  await expect(page.getByLabel('Название материала')).toHaveCount(0);
  await search.fill('Регламент витрины');
  await expect(page.getByRole('option', { name: 'Регламент витрины' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Название материала')).toHaveValue('Регламент витрины');

  await search.fill('Контакт мастера');
  await expect(page.getByRole('option', { name: 'Контакт мастера' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Имя контакта')).toHaveValue('Контакт мастера');
});

test('knowledge detail and People form are keyboard-safe without overflow at exactly 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  expect(await page.evaluate(() => window.innerWidth)).toBe(360);

  await page.getByRole('link', { name: 'База' }).last().click();
  await expect(page.getByRole('heading', { name: 'База знаний' })).toBeVisible();
  const knowledgeCard = page.getByRole('button', { name: 'Открыть материал Плотная забивка чаши' });
  await knowledgeCard.click();
  await expect(page.getByRole('complementary', { name: 'Детали материала' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Закрыть' })).toBeFocused();
  await expect(knowledgeCard).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(knowledgeCard).toBeFocused();

  await page.getByRole('link', { name: 'Люди' }).last().click();
  const teamTab = page.getByRole('tab', { name: 'Команда' });
  const contactsTab = page.getByRole('tab', { name: 'Контакты' });
  await teamTab.focus();
  await teamTab.press('ArrowRight');
  await expect(contactsTab).toBeFocused();
  await expect(contactsTab).toHaveAttribute('aria-selected', 'true');
  await contactsTab.press('Home');
  await expect(teamTab).toBeFocused();
  await expect(teamTab).toHaveAttribute('aria-selected', 'true');
  await teamTab.press('End');
  await expect(contactsTab).toBeFocused();
  await page.getByRole('button', { name: 'Добавить контакт' }).click();
  await expect(page.getByRole('form', { name: 'Контакт' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const formBox = await page.getByRole('form', { name: 'Контакт' }).boundingBox();
  expect(formBox).not.toBeNull();
  expect(formBox!.x).toBeGreaterThanOrEqual(0);
  expect(formBox!.x + formBox!.width).toBeLessThanOrEqual(360);
  await page.getByRole('form', { name: 'Контакт' }).press('Escape');
  await expect(page.getByRole('button', { name: 'Добавить контакт' })).toBeFocused();
});
