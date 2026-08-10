import { expect, test } from '@playwright/test';

const TELEGRAM_SCRIPT = 'https://telegram.org/js/telegram-web-app.js?63';

function assertProductionHeaders(headers: Record<string, string>, api = false) {
  const csp = headers['content-security-policy'] ?? '';
  const scriptDirective = csp.split(';').find((directive) => directive.trimStart().startsWith('script-src')) ?? '';
  expect(csp).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
  expect(scriptDirective).toMatch(/'nonce-[a-f0-9]{32}'/u);
  expect(scriptDirective).toContain("'strict-dynamic'");
  expect(scriptDirective).not.toContain("'unsafe-inline'");
  expect(scriptDirective).not.toContain("'unsafe-eval'");
  expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['x-frame-options']).toBeUndefined();
  expect(headers['x-powered-by']).toBeUndefined();
  if (api) expect(headers['cache-control']).toContain('no-store');
}

test('serves production headers and nonce-bearing Telegram bridge before application bootstrap', async ({ request }) => {
  const first = await request.get('/');
  const second = await request.get('/');
  const api = await request.get('/api/tasks');
  expect(first.status()).toBe(200);
  expect([401, 503]).toContain(api.status());
  assertProductionHeaders(first.headers());
  assertProductionHeaders(api.headers(), true);
  const firstNonce = first.headers()['content-security-policy']?.match(/'nonce-([a-f0-9]{32})'/u)?.[1];
  const secondNonce = second.headers()['content-security-policy']?.match(/'nonce-([a-f0-9]{32})'/u)?.[1];
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toBe(secondNonce);

  const html = await first.text();
  const escapedTelegramScript = TELEGRAM_SCRIPT.replace(/[.?]/gu, '\\$&');
  const bridgeTag = html.match(new RegExp(
    `<script(?=[^>]*\\bsrc="${escapedTelegramScript}")(?=[^>]*\\bnonce="${firstNonce}")[^>]*><\\/script>`,
    'u',
  ));
  expect(bridgeTag).not.toBeNull();
  expect(bridgeTag?.[0]).not.toMatch(/\s(?:async|defer)(?:=|\s|>)/u);
  const bridgeIndex = bridgeTag?.index ?? -1;
  const bodyIndex = html.indexOf('<body');
  const hydrationBootstrapIndex = html.indexOf('id="_R_"');
  expect(bridgeIndex).toBeGreaterThan(0);
  expect(bridgeIndex).toBeLessThan(html.indexOf('</head>'));
  expect(bridgeIndex).toBeLessThan(bodyIndex);
  expect(hydrationBootstrapIndex).toBeGreaterThan(bodyIndex);
  expect(bridgeIndex).toBeLessThan(hydrationBootstrapIndex);
});

test('shows only the server-configured Telegram action outside Telegram', async ({ page }) => {
  await page.route(TELEGRAM_SCRIPT, async (route) => {
    await route.fulfill({ body: 'window.Telegram = { WebApp: { initData: "" } };', contentType: 'application/javascript' });
  });
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  assertProductionHeaders(response!.headers());
  await expect(page.locator('.bootstrap-state').getByRole('alert'))
    .toHaveText('Откройте приложение в Telegram для безопасного входа.');
  await expect(page.getByRole('link', { name: 'Открыть в Telegram' })).toHaveAttribute(
    'href', 'https://t.me/smoking_zen_bot/workspace',
  );
  await expect(page.getByRole('heading', { name: /Сегодня|Задачи|База знаний|Люди|Сейф|Корзина/u })).toHaveCount(0);
});
