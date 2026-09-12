import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

await mkdir('output/site-qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.argv[2] || 'http://127.0.0.1:5173/');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.stage.has-canvas').waitFor();
    await page.screenshot({ path: `output/site-qa/${name}-hero.png` });
    await page.locator('[data-chapter-target="0.53"]').click();
    await page.waitForFunction(
      () => Math.abs(Number(document.querySelector('#aircraft-canvas').dataset.frame) - 127) <= 1,
    );
    await page.screenshot({ path: `output/site-qa/${name}-exploded.png` });
    await page
      .locator('#details')
      .evaluate((element) => element.scrollIntoView({ behavior: 'instant', block: 'start' }));
    await page.locator('.technical-image > img').evaluate((image) => image.decode());
    await page.screenshot({ path: `output/site-qa/${name}-details.png` });
    await page.locator('.round-cta').click();
    await page.screenshot({ path: `output/site-qa/${name}-configurator.png` });
    console.log(
      JSON.stringify({
        viewport: name,
        pageErrors: errors,
        overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
