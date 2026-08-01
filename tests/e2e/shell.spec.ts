import { expect, test } from '@playwright/test';

function contrastRatio(foreground: string, background: string) {
  const parse = (color: string) => {
    const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);

    if (!channels || channels.length !== 3) {
      throw new Error(`Expected an RGB color, received ${color}`);
    }

    return channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  };
  const luminance = (color: number[]) =>
    0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const [light, dark] = [luminance(parse(foreground)), luminance(parse(background))].sort(
    (first, second) => second - first,
  );

  return (light + 0.05) / (dark + 0.05);
}

test('keeps muted shell text at WCAG AA contrast', async ({ page }) => {
  await page.goto('/');

  const colors = await page.evaluate(() => {
    const navigationLink = document.querySelector<HTMLAnchorElement>(
      '.navigation--sidebar a[href="#tasks"]',
    );
    const sidebar = document.querySelector<HTMLElement>('.app-shell__sidebar');
    const banner = document.querySelector<HTMLElement>('.demo-banner');

    if (!navigationLink || !sidebar || !banner) {
      throw new Error('Expected shell text elements are missing');
    }

    return {
      banner: {
        background: getComputedStyle(document.body).backgroundColor,
        foreground: getComputedStyle(banner).color,
      },
      navigation: {
        background: getComputedStyle(sidebar).backgroundColor,
        foreground: getComputedStyle(navigationLink).color,
      },
    };
  });

  expect(contrastRatio(colors.navigation.foreground, colors.navigation.background)).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(contrastRatio(colors.banner.foreground, colors.banner.background)).toBeGreaterThanOrEqual(4.5);
});

test('shows the desktop workspace shell', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop-only assertion');

  await page.goto('/');

  const navigation = page.locator('.navigation--sidebar');

  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Сегодня' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(navigation.getByRole('link').allTextContents()).resolves.toEqual([
    'Сегодня',
    'Задачи',
    'База',
    'Люди',
  ]);
  await expect(page.locator('.app-shell__create')).toBeVisible();
  await expect(page.locator('.app-shell__floating-create')).toBeHidden();
  await expect(page.getByText('Демо-режим: рабочие данные не подключены.')).toBeVisible();
});

test('shows ordered bottom navigation and a create control on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile-only assertion');

  await page.goto('/');

  const navigation = page.locator('.navigation--bottom');

  await expect(page.locator('.app-shell__sidebar')).toBeHidden();
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('link').allTextContents()).resolves.toEqual([
    'Сегодня',
    'Задачи',
    'База',
    'Люди',
  ]);
  await expect(navigation.getByRole('link', { name: 'Сегодня' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.app-shell__floating-create')).toBeVisible();
  await expect(page.locator('.app-shell__create')).toBeHidden();
});
