import { test, expect } from '@playwright/test';

test('landing page renders, scrolls through the assembly sequence, and has no overflow', async ({
  page,
  baseURL,
}) => {
  const errors = [];
  const missingAssets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) missingAssets.push(`${response.status()} ${response.url()}`);
  });
  const firstFrame = page.waitForResponse(
    (response) =>
      response.url().startsWith(new URL('media/frames/', baseURL).href) && response.ok(),
  );
  await page.goto('./');
  await firstFrame;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Земля\s*подождёт\./);
  await expect(page.locator('#stage')).toHaveClass(/has-canvas/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (page.viewportSize().width < 760) {
    const menu = page.getByRole('button', { name: 'Открыть меню' });
    await menu.click();
    await expect(page.locator('.menu-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(page.locator('.menu-toggle')).toHaveAttribute('aria-expanded', 'false');
  }
  await page.locator('[data-chapter-target="0.53"]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-chapter', '1');
  await expect
    .poll(async () => Number(await page.locator('#aircraft-canvas').getAttribute('data-frame')))
    .toBeGreaterThan(100);
  await page.locator('[data-chapter-target="0.91"]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-chapter', '2');
  await expect(page.getByRole('heading', { name: 'Вместе — значит КЕДР.' })).toBeVisible();
  await page.locator('#details').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Узнать про живой модуль', exact: true }).click();
  await expect(page.locator('[data-component-panel="green"]')).toHaveAttribute('open', '');
  await expect(page.locator('[data-component-panel="drive"]')).not.toHaveAttribute('open', '');
  await expect
    .poll(() =>
      page
        .locator('.technical-image img')
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  expect(errors).toEqual([]);
  expect(missingAssets).toEqual([]);
});

test('configuration is downloadable and Escape restores focus', async ({ page }) => {
  await page.goto('./');
  const opener = page.locator('.header-cta');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'У каждого свой маршрут.' });
  await expect(dialog).toBeVisible();
  await page.getByRole('radio', { name: 'Экспедиция' }).check();
  await page.getByRole('radio', { name: 'Расширенный', exact: true }).check();
  await expect(page.locator('#config-summary')).toContainText('Экспедиция / Расширенный');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать спецификацию' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('KEDR-01-specification.txt');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole('radio', { name: 'Экспедиция' })).toBeChecked();
});

test('reduced motion uses a static poster without fetching the entire sequence', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const frames = [];
  page.on('request', (request) => {
    if (request.url().includes('/media/frames/')) frames.push(request.url());
  });
  await page.goto('./');
  await expect(page.locator('#sequence-status')).toContainText('Статичный режим');
  await expect(page.locator('#stage')).toHaveClass(/has-canvas/);
  await page.locator('[data-chapter-target="0.53"]').click();
  await expect(page.locator('#aircraft-canvas')).toHaveAttribute('data-frame', '0');
  expect(frames).toHaveLength(0);
});

test('the film loads on demand and closes with the keyboard', async ({ page, baseURL }) => {
  await page.goto('./');
  await expect(page.locator('#product-film')).not.toHaveAttribute('src');
  const filmResponse = page.waitForResponse(
    (response) => response.url() === new URL('media/film.mp4', baseURL).href && response.ok(),
  );
  await page.getByRole('button', { name: /Смотреть фильм/ }).click();
  await expect(page.locator('#film-dialog')).toBeVisible();
  await expect(page.locator('#product-film')).toHaveAttribute(
    'src',
    new URL('media/film.mp4', baseURL).pathname,
  );
  await filmResponse;
  await expect
    .poll(() => page.locator('#product-film').evaluate((video) => video.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#film-dialog')).not.toBeVisible();
  await expect
    .poll(() => page.locator('#product-film').evaluate((video) => video.paused))
    .toBe(true);
});
