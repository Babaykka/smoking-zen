import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const mobileProjects = new Set(['mobile-chromium', 'mobile-landscape', 'ios-webkit', 'small-ios-webkit']);
const telegramFixtureProjects = new Set(['telegram-web', ...mobileProjects]);
const browserErrors = new WeakMap<Page, string[]>();
const telegramBridgeFixture = `
  window.__telegramCalls = [];
  window.__telegramEvents = {};
  window.__telegramBack = undefined;
  window.Telegram = { WebApp: {
    initData: 'fixture-only-not-posted-in-demo',
    version: '6.1',
    isVersionAtLeast: (version) => version === '6.1',
    colorScheme: 'light',
    themeParams: { bg_color: '#f5f4f0', text_color: '#202020', button_color: '#1f7a62' },
    viewportHeight: window.innerHeight,
    viewportStableHeight: window.innerHeight - 20,
    safeAreaInset: { top: 8, right: 0, bottom: 10, left: 0 },
    contentSafeAreaInset: { top: 4, right: 0, bottom: 6, left: 0 },
    ready: () => window.__telegramCalls.push('ready'),
    expand: () => window.__telegramCalls.push('expand'),
    onEvent: (event, listener) => { window.__telegramEvents[event] = listener; },
    offEvent: (event, listener) => { if (window.__telegramEvents[event] === listener) delete window.__telegramEvents[event]; },
    BackButton: {
      show: () => window.__telegramCalls.push('back:show'),
      hide: () => window.__telegramCalls.push('back:hide'),
      onClick: (listener) => { window.__telegramBack = listener; },
      offClick: (listener) => { if (window.__telegramBack === listener) window.__telegramBack = undefined; },
    },
  } };
`;
test.setTimeout(60_000);

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    animations: 'disabled',
    caret: 'initial',
    fullPage: true,
    path: `output/playwright/task8-final/${testInfo.project.name}-${name}.png`,
  });
}

async function visibleNavigation(page: Page) {
  return page.locator('.navigation:visible');
}

async function navigateSecondary(page: Page, name: 'Сейф' | 'Корзина') {
  const navigation = await visibleNavigation(page);
  const direct = navigation.getByRole('link', { name });
  if (await direct.isVisible()) await direct.click();
  else {
    await navigation.getByRole('button', { name: 'Ещё' }).click();
    await navigation.getByRole('menuitem', { name }).click();
  }
}

async function expectNoSeriousAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? '')))
    .toEqual([]);
}

async function expectMinimumTarget(locator: ReturnType<Page['locator']>, minimum = 44) {
  const targets = await locator.evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName, width: box.width, height: box.height };
    }));
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(minimum);
    expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(minimum);
  }
}

async function expectViewportClearOfBottomChrome(page: Page) {
  const geometry = await page.evaluate(() => {
    const navigation = document.querySelector<HTMLElement>('.navigation--bottom');
    const create = document.querySelector<HTMLElement>('.app-shell__floating-create');
    const content = document.querySelector<HTMLElement>('.app-shell__content');
    const navigationBox = navigation?.getBoundingClientRect();
    const createBox = create && getComputedStyle(create).display !== 'none' ? create.getBoundingClientRect() : undefined;
    const contentBox = content?.getBoundingClientRect();
    const overlaps = (left: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, right?: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>) => !!right
      && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const collisions = Array.from(document.querySelectorAll<HTMLElement>('.task-card, .today-group__heading span'))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const painted = {
          bottom: Math.min(box.bottom, contentBox?.bottom ?? window.innerHeight, window.innerHeight),
          left: Math.max(box.left, contentBox?.left ?? 0, 0),
          right: Math.min(box.right, contentBox?.right ?? window.innerWidth, window.innerWidth),
          top: Math.max(box.top, contentBox?.top ?? 0, 0),
        };
        return painted.bottom > painted.top && painted.right > painted.left
          && (overlaps(painted, navigationBox) || overlaps(painted, createBox));
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          bottom: Math.round(box.bottom),
          label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.className,
          navigationTop: Math.round(navigationBox?.top ?? 0),
          top: Math.round(box.top),
        };
      });
    return {
      collisions,
      createVisible: !!create && getComputedStyle(create).display !== 'none',
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      scrollable: document.documentElement.scrollHeight > window.innerHeight || !!content && content.scrollHeight > content.clientHeight,
    };
  });
  expect(geometry).toEqual({ collisions: [], createVisible: false, horizontalOverflow: false, scrollable: true });
}

test.beforeEach(async ({ page }, testInfo) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  if (telegramFixtureProjects.has(testInfo.project.name)) {
    await page.route('https://telegram.org/js/telegram-web-app.js?63', async (route) => {
      await route.fulfill({ body: telegramBridgeFixture, contentType: 'application/javascript' });
    });
  }
  await page.goto('/');
  if (telegramFixtureProjects.has(testInfo.project.name)) {
    await page.waitForFunction(() => document.documentElement.style
      .getPropertyValue('--tg-viewport-stable-height').endsWith('px'));
  }
});

test('renders primary workspaces, details, history, and forms without serious accessibility defects', async ({ page }, testInfo) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Сегодня' })).toBeVisible();
  for (const heading of ['Просрочено', 'На сегодня', 'P1/P2 без исполнителя', 'Последние изменения']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'today');

  const navigation = await visibleNavigation(page);
  await navigation.getByRole('link', { name: 'Задачи' }).click();
  await page.getByRole('button', { name: 'Открыть задачу Проверить запас кокосового угля' }).click();
  await expect(page.getByRole('heading', { name: 'История' })).toBeVisible();
  await expect(page.getByText('Изменений пока нет.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Новый комментарий' }).scrollIntoViewIfNeeded();
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'task-detail');
  if (telegramFixtureProjects.has(testInfo.project.name)) {
    await page.evaluate(() => (window as typeof window & { __telegramBack?: () => void }).__telegramBack?.());
    await expect(page.getByRole('complementary', { name: 'Детали задачи' })).toBeHidden();
  } else {
    await page.getByRole('button', { name: 'Закрыть' }).click();
  }

  await (await visibleNavigation(page)).getByRole('link', { name: 'База' }).click();
  await page.getByRole('button', { name: 'Открыть материал Плотная забивка чаши' }).click();
  await expect(page.getByRole('heading', { name: 'История материала' })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'knowledge-detail');
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await (await visibleNavigation(page)).getByRole('link', { name: 'Люди' }).click();
  await page.getByRole('tab', { name: 'Контакты' }).click();
  const contactOpener = page.getByRole('button', { name: 'Добавить контакт' });
  await contactOpener.click();
  await expect(page.getByLabel('Имя контакта')).toBeFocused();
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'contact-form');
  await page.getByRole('form', { name: 'Контакт' }).press('Escape');
  await expect(contactOpener).toBeFocused();

  await navigateSecondary(page, 'Сейф');
  await page.getByRole('button', { name: 'Изменить Касса' }).click();
  await expect(page.getByRole('heading', { name: 'История записи' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/vault\.bitwarden|storage_path|signed/iu);
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'safe-editor');
  await page.getByRole('button', { name: 'Закрыть редактор' }).click();

  await navigateSecondary(page, 'Корзина');
  await expect(page.getByRole('heading', { level: 1, name: 'Корзина' })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'trash');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (telegramFixtureProjects.has(testInfo.project.name)) {
    const telegramState = await page.evaluate(() => ({
      calls: (window as typeof window & { __telegramCalls?: string[] }).__telegramCalls,
      safeBottom: document.documentElement.style.getPropertyValue('--tg-safe-area-inset-bottom'),
      contentBottom: document.documentElement.style.getPropertyValue('--tg-content-safe-area-inset-bottom'),
      stableHeight: document.documentElement.style.getPropertyValue('--tg-viewport-stable-height'),
    }));
    expect(telegramState.calls)
      .toEqual(expect.arrayContaining(['ready', 'expand', 'back:show', 'back:hide']));
    expect(telegramState).toMatchObject({ safeBottom: '10px', contentBottom: '6px' });
    expect(telegramState.stableHeight).toMatch(/^\d+px$/u);
  }
});

test('keeps mobile chrome, menus, zoom, and focused controls unobstructed', async ({ page }, testInfo) => {
  test.skip(!mobileProjects.has(testInfo.project.name), 'Mobile matrix only.');
  const filterToggle = page.getByRole('button', { name: 'Фильтры задач' });
  const taskFilters = page.locator('#task-filters');
  const todayTask = page.getByRole('button', { name: 'Открыть задачу Проверить запас кокосового угля' });
  await expect(filterToggle).toBeVisible();
  expect(browserErrors.get(page)?.filter((message) => /hydrat|uncaught|error:/iu.test(message))).toEqual([]);
  await expectMinimumTarget(filterToggle);
  await expect(taskFilters).toBeHidden();
  await expect(todayTask).toBeVisible();
  if (testInfo.project.name === 'mobile-landscape') {
    await todayTask.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  }
  const compactGeometry = await page.evaluate(() => {
    const task = document.querySelector<HTMLElement>('.task-card')?.getBoundingClientRect();
    const create = document.querySelector<HTMLElement>('.app-shell__floating-create')?.getBoundingClientRect();
    const navigation = document.querySelector<HTMLElement>('.navigation--bottom')?.getBoundingClientRect();
    const overlaps = (left?: DOMRect, right?: DOMRect) => !!left && !!right
      && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    return { taskAboveNavigation: !!task && !!navigation && task.top < navigation.top, overlapsCreate: overlaps(task, create) };
  });
  expect(compactGeometry).toEqual({ taskAboveNavigation: true, overlapsCreate: false });
  await screenshot(page, testInfo, 'today-compact');
  await filterToggle.click();
  await expect(taskFilters).toBeVisible();
  await expectMinimumTarget(taskFilters.locator('button, select'));
  await filterToggle.click();
  await expect(taskFilters).toBeHidden();

  const navigation = await visibleNavigation(page);
  await expect(navigation).toHaveClass(/navigation--bottom/u);
  const more = navigation.getByRole('button', { name: 'Ещё' });
  await more.click();
  const menu = navigation.getByRole('menu');
  const safe = navigation.getByRole('menuitem', { name: 'Сейф' });
  const trash = navigation.getByRole('menuitem', { name: 'Корзина' });
  await expect(safe).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(trash).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(safe).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(trash).toBeFocused();
  await page.keyboard.press('Home');
  await expect(safe).toBeFocused();
  await page.keyboard.press('End');
  await expect(trash).toBeFocused();
  await expectMinimumTarget(navigation.locator('.navigation__link'));
  await expectNoSeriousAxeViolations(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Корзина' })).toBeVisible();
  await expect(more).toHaveAttribute('aria-current', 'page');
  await more.click();
  await expect(safe).toBeFocused();
  await expect(page.locator('.app-shell__floating-create')).toBeHidden();
  await menu.press('Escape');
  await expect(more).toBeFocused();

  await navigation.getByRole('link', { name: 'Задачи' }).click();
  await expectMinimumTarget(page.locator('.task-views button, .task-filters-toggle'));
  await page.getByRole('button', { name: 'Открыть задачу Проверить запас кокосового угля' }).click();
  const comment = page.getByRole('textbox', { name: 'Новый комментарий' });
  await comment.scrollIntoViewIfNeeded();
  await comment.focus();
  const geometry = await page.evaluate(() => {
    const field = document.activeElement?.getBoundingClientRect();
    const navigationBox = document.querySelector('.navigation--bottom')?.getBoundingClientRect();
    return { fieldBottom: field?.bottom ?? Infinity, navigationTop: navigationBox?.top ?? 0 };
  });
  expect(geometry.fieldBottom).toBeLessThanOrEqual(geometry.navigationTop);
  await expect(page.locator('.app-shell__floating-create')).toBeHidden();
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await navigation.getByRole('link', { name: 'База' }).click();
  await page.getByRole('button', { name: 'Открыть материал Плотная забивка чаши' }).click();
  await expectMinimumTarget(page.getByRole('button', { name: 'Архивировать материал' }));
  await page.getByRole('button', { name: 'Закрыть' }).click();

  if (testInfo.project.name === 'mobile-chromium') {
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, testInfo, 'zoom-200');
  }
});

test('keeps expanded filters and the final task groups clear of fixed mobile chrome', async ({ page }, testInfo) => {
  test.skip(!['mobile-chromium', 'small-ios-webkit'].includes(testInfo.project.name), 'Focused Chromium/WebKit mobile proof.');
  for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'Фильтры задач' }).click();
    await expect(page.locator('#task-filters')).toBeVisible();
    await expect(page.locator('.app-shell__floating-create')).toBeHidden();

    const lastCount = page.locator('.today-group__heading span').last();
    await lastCount.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    await expectViewportClearOfBottomChrome(page);

    const lastTask = page.locator('.task-card').last();
    await lastTask.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    await expectViewportClearOfBottomChrome(page);
    await screenshot(page, testInfo, `filters-${viewport.width}x${viewport.height}`);
  }
});

test('reflows the task CTA, cards, and accessible icon navigation at a 180px CSS viewport', async ({ page }, testInfo) => {
  test.skip(!['mobile-chromium', 'small-ios-webkit'].includes(testInfo.project.name), 'Focused Chromium/WebKit 200% reflow proof.');
  await page.setViewportSize({ width: 180, height: 800 });
  await page.goto('/');

  const cta = page.getByRole('button', { name: 'Быстрая задача' });
  await expect(cta).toBeVisible();
  const ctaGeometry = await cta.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      fullyInside: box.left >= 0 && box.right <= window.innerWidth,
      textUnclipped: element.scrollWidth <= element.clientWidth,
    };
  });
  expect(ctaGeometry).toEqual({ fullyInside: true, textUnclipped: true });
  await cta.click();
  const quickForm = page.getByRole('form', { name: 'Быстрое создание задачи' });
  await expect(quickForm).toBeVisible();
  const formOverflow = await quickForm.locator('input, button').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, viewport: window.innerWidth };
  }).filter(({ left, right, viewport }) => left < 0 || right > viewport));
  expect(formOverflow).toEqual([]);

  const taskTitle = page.locator('.task-card__body strong').first();
  const titleGeometry = await taskTitle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const explicitLineHeight = Number.parseFloat(style.lineHeight);
    const lineHeight = Number.isFinite(explicitLineHeight) ? explicitLineHeight : Number.parseFloat(style.fontSize) * 1.2;
    return { width: box.width, lines: box.height / lineHeight };
  });
  expect(titleGeometry.width).toBeGreaterThanOrEqual(64);
  expect(titleGeometry.lines).toBeLessThanOrEqual(4);

  const navigation = await visibleNavigation(page);
  for (const name of ['Сегодня', 'Задачи', 'База', 'Люди']) {
    await expect(navigation.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(navigation.getByRole('button', { name: 'Ещё', exact: true })).toBeVisible();
  expect(await navigation.locator('.navigation__link > span').evaluateAll((labels) => labels.filter((label) => !label.closest('.navigation__secondary-menu') && getComputedStyle(label).display !== 'none').length)).toBe(0);
  await expect(page.locator('.app-shell__floating-create')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, testInfo, 'reflow-180x800');
  await quickForm.getByRole('button', { name: 'Отмена' }).click();
  await taskTitle.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expectViewportClearOfBottomChrome(page);
  await screenshot(page, testInfo, 'reflow-180x800-task-card');
});

test('keeps the collapsed 320x568 task card clear by hiding the collision-prone FAB', async ({ page }, testInfo) => {
  test.skip(!['mobile-chromium', 'small-ios-webkit'].includes(testInfo.project.name), 'Focused Chromium/WebKit compact-height proof.');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.locator('#task-filters')).toBeHidden();

  const cta = page.getByRole('button', { name: 'Быстрая задача' });
  await cta.click();
  const quickForm = page.getByRole('form', { name: 'Быстрое создание задачи' });
  await expect(quickForm).toBeVisible();
  await quickForm.getByRole('button', { name: 'Отмена' }).click();

  const firstCard = page.locator('.today-group').first().locator('.task-card').first();
  await firstCard.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const geometry = await page.evaluate(() => {
    const rounded = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        bottom: Math.round(box.bottom), height: Math.round(box.height), left: Math.round(box.left),
        right: Math.round(box.right), top: Math.round(box.top), width: Math.round(box.width),
      };
    };
    const overlaps = (left: ReturnType<typeof rounded>, right: ReturnType<typeof rounded>) => !!left && !!right
      && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const ctaElement = document.querySelector<HTMLElement>('.tasks-header > .task-secondary-button');
    const fabElement = document.querySelector<HTMLElement>('.app-shell__floating-create');
    const cardElement = document.querySelector<HTMLElement>('.today-group .task-card');
    const countElement = document.querySelector<HTMLElement>('.today-group__heading span');
    const navigationElement = document.querySelector<HTMLElement>('.navigation--bottom');
    const ctaBox = rounded(ctaElement);
    const fabBox = rounded(fabElement);
    const cardBox = rounded(cardElement);
    const countBox = rounded(countElement);
    const navigationBox = rounded(navigationElement);
    return {
      cardBox, countBox, ctaBox, fabBox, navigationBox,
      cardFabCollision: overlaps(cardBox, fabBox),
      cardNavigationCollision: overlaps(cardBox, navigationBox),
      countFabCollision: overlaps(countBox, fabBox),
      countNavigationCollision: overlaps(countBox, navigationBox),
      ctaInsideViewport: !!ctaBox && ctaBox.left >= 0 && ctaBox.right <= window.innerWidth,
      fabVisible: !!fabElement && getComputedStyle(fabElement).display !== 'none',
    };
  });
  expect(geometry.ctaInsideViewport, JSON.stringify(geometry, null, 2)).toBe(true);
  expect(geometry.fabVisible, JSON.stringify(geometry, null, 2)).toBe(false);
  expect(geometry.cardFabCollision, JSON.stringify(geometry, null, 2)).toBe(false);
  expect(geometry.countFabCollision, JSON.stringify(geometry, null, 2)).toBe(false);
  expect(geometry.cardNavigationCollision, JSON.stringify(geometry, null, 2)).toBe(false);
  expect(geometry.countNavigationCollision, JSON.stringify(geometry, null, 2)).toBe(false);
  await screenshot(page, testInfo, 'collapsed-320x568');
});

test('hides the redundant FAB on the 375x667 compact iOS viewport', async ({ page }, testInfo) => {
  test.skip(!['mobile-chromium', 'small-ios-webkit'].includes(testInfo.project.name), 'Focused Chromium/WebKit compact-height proof.');
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Быстрая задача' })).toBeVisible();
  await expect(page.locator('.app-shell__floating-create')).toBeHidden();
});

test('uses effective inline size when the 360px viewport body is actually zoomed to 200%', async ({ page }, testInfo) => {
  test.skip(!['mobile-chromium', 'small-ios-webkit'].includes(testInfo.project.name), 'Focused Chromium/WebKit body zoom proof.');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  const zoomSupported = await page.evaluate(() => CSS.supports('zoom', '2'));
  test.skip(!zoomSupported, 'CSS zoom is not supported by this engine.');
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).zoom)).toBe('2');

  const initialGeometry = await page.evaluate(() => {
    const cta = document.querySelector<HTMLElement>('.tasks-header > .task-secondary-button')?.getBoundingClientRect();
    return {
      cta: cta ? { left: Math.round(cta.left), right: Math.round(cta.right), top: Math.round(cta.top), bottom: Math.round(cta.bottom) } : null,
      ctaInsideViewport: !!cta && cta.left >= 0 && cta.right <= window.innerWidth,
      viewportWidth: window.innerWidth,
    };
  });

  const firstCard = page.locator('.today-group .task-card').first();
  await firstCard.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const zoomGeometry = await page.evaluate(() => {
    const rounded = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        bottom: Math.round(box.bottom), height: Math.round(box.height), left: Math.round(box.left),
        right: Math.round(box.right), top: Math.round(box.top), width: Math.round(box.width),
      };
    };
    const overlaps = (left: ReturnType<typeof rounded>, right: ReturnType<typeof rounded>) => !!left && !!right
      && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const fabElement = document.querySelector<HTMLElement>('.app-shell__floating-create');
    const cardElement = document.querySelector<HTMLElement>('.today-group .task-card');
    const contentElement = document.querySelector<HTMLElement>('.app-shell__content');
    const navigationElement = document.querySelector<HTMLElement>('.navigation--bottom');
    const fabBox = rounded(fabElement);
    const cardBox = rounded(cardElement);
    const contentBox = rounded(contentElement);
    const navigationBox = rounded(navigationElement);
    const labelElements = Array.from(document.querySelectorAll<HTMLElement>('.navigation--bottom > .navigation__link > span, .navigation--bottom > .navigation__secondary > .navigation__link > span'))
      .filter((element) => getComputedStyle(element).display !== 'none');
    const labelBoxes = labelElements.map((element) => rounded(element)).filter((box): box is NonNullable<typeof box> => box !== null);
    return {
      cardBox,
      cardFabCollision: overlaps(cardBox, fabBox),
      cardNavigationCollision: overlaps(cardBox, navigationBox),
      content: contentElement ? {
        box: contentBox,
        clientHeight: contentElement.clientHeight,
        overflowY: getComputedStyle(contentElement).overflowY,
        scrollHeight: contentElement.scrollHeight,
        scrollTop: contentElement.scrollTop,
      } : null,
      fabBox, labelBoxes, navigationBox,
      fabNavigationCollision: overlaps(fabBox, navigationBox),
      fabVisible: !!fabElement && getComputedStyle(fabElement).display !== 'none',
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      labelsOverlap: labelBoxes.some((left, index) => labelBoxes.slice(index + 1).some((right) => overlaps(left, right))),
      visibleLabelCount: labelBoxes.length,
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  });
  const evidence = JSON.stringify({ initialGeometry, zoomGeometry }, null, 2);
  expect(initialGeometry.ctaInsideViewport, evidence).toBe(true);
  expect(zoomGeometry.visibleLabelCount, evidence).toBe(0);
  expect(zoomGeometry.labelsOverlap, evidence).toBe(false);
  expect(zoomGeometry.fabVisible, evidence).toBe(false);
  expect(zoomGeometry.cardFabCollision, evidence).toBe(false);
  expect(zoomGeometry.cardNavigationCollision, evidence).toBe(false);
  expect(zoomGeometry.fabNavigationCollision, evidence).toBe(false);
  const navigation = await visibleNavigation(page);
  await expect(navigation.getByRole('link', { name: 'Сегодня', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Ещё', exact: true })).toBeVisible();
  await page.locator('.app-shell__content').evaluate((element) => element.scrollTo({ top: 0 }));
  await page.screenshot({ animations: 'disabled', path: `output/playwright/task8-final/${testInfo.project.name}-body-zoom-200-top.png` });
  await firstCard.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await page.screenshot({ animations: 'disabled', path: `output/playwright/task8-final/${testInfo.project.name}-body-zoom-200-card.png` });
});

test('supports command search, reduced motion, and accessible error state', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One keyboard/reduced-motion proof is sufficient.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.animationDuration = '10s';
    probe.style.transitionDuration = '10s';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = { animation: style.animationDuration, transition: style.transitionDuration, media: matchMedia('(prefers-reduced-motion: reduce)').matches };
    probe.remove();
    return result;
  });
  expect(reducedMotion).toEqual({ animation: '1e-05s', transition: '1e-05s', media: true });

  const search = page.getByRole('combobox', { name: 'Поиск по штабу' });
  await expect(search).toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(search).toBeFocused();
  await search.fill('кокосового');
  await expect(page.getByRole('option', { name: 'Проверить запас кокосового угля' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Детали задачи' })).toBeVisible();
  await page.getByRole('complementary', { name: 'Детали задачи' }).press('Escape');

  await page.getByRole('button', { name: 'Быстрая задача' }).click();
  await page.getByRole('form', { name: 'Быстрое создание задачи' }).getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByRole('form', { name: 'Быстрое создание задачи' }).getByRole('alert')).toHaveText('Введите название задачи.');
  await expectNoSeriousAxeViolations(page);
  await screenshot(page, testInfo, 'validation-error');
});

test('serves request-nonce security headers on documents and API errors', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One deployed-style header proof is sufficient.');
  const firstDocument = await request.get('/');
  const secondDocument = await request.get('/');
  const apiError = await request.get('/api/tasks');
  expect(firstDocument.status()).toBe(200);
  expect([401, 503]).toContain(apiError.status());

  const required = (response: typeof firstDocument, api = false) => {
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
    expect(csp).toMatch(/script-src[^;]*'nonce-[a-f0-9]{32}'[^;]*'strict-dynamic'/u);
    const scriptDirective = csp.split(';').find((directive) => directive.trimStart().startsWith('script-src')) ?? '';
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['x-frame-options']).toBeUndefined();
    expect(headers['x-powered-by']).toBeUndefined();
    if (api) expect(headers['cache-control']).toContain('no-store');
    return csp.match(/'nonce-([a-f0-9]{32})'/u)?.[1];
  };
  const firstNonce = required(firstDocument);
  const secondNonce = required(secondDocument);
  required(apiError, true);
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(firstNonce).not.toBe(secondNonce);
});
