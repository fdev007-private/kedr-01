import { chromium } from '@playwright/test';

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url))
  throw new Error('Usage: node scripts/measure-sequence.mjs URL [--mobile] [--throttle]');
const mobile = process.argv.includes('--mobile');
const throttled = process.argv.includes('--throttle');
const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'chrome',
  headless: true,
});
try {
  const context = await browser.newContext(
    mobile
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        }
      : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 },
  );
  const page = await context.newPage();
  if (throttled) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: 625000,
      uploadThroughput: 125000,
    });
  }
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    const state = { draws: 0, samples: [], active: false, actual: 0, lastRaf: null, longTasks: [] };
    window.__sequenceProbe = state;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      const match = (image.currentSrc || image.src || '').match(/frame-(\d+)\.webp/);
      state.actual =
        this.canvas.dataset.drawnFrame !== undefined
          ? Number(this.canvas.dataset.drawnFrame)
          : match
            ? Number(match[1]) - 1
            : 0;
      if (state.active) state.draws++;
      return drawImage.call(this, image, ...args);
    };
    new PerformanceObserver((list) => {
      if (state.active) for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
    function sample(time) {
      const canvas = document.querySelector('#aircraft-canvas');
      if (state.active && canvas && state.lastRaf !== null) {
        state.samples.push({
          actual: state.actual,
          desired: Number(canvas.dataset.frame),
          gap: time - state.lastRaf,
        });
      }
      state.lastRaf = time;
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  for (const run of ['cold', 'warm']) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stage.has-canvas');
    const result = await page.evaluate(async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const resources = () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => /\/media\/(frames|packs)\//.test(entry.name));
      const readyAtMs = Math.round(performance.now());
      await pause(1500);
      const countFrames = (names) =>
        [...names].reduce((sum, name) => sum + (name.includes('/media/packs/') ? 16 : 1), 0);
      const framesBeforeScroll = countFrames(new Set(resources().map((entry) => entry.name)));
      const distance =
        document.querySelector('.journey').offsetHeight -
        document.querySelector('#stage').offsetHeight;
      const start = performance.now();
      const state = window.__sequenceProbe;
      state.active = true;
      await new Promise((resolve) => {
        function step(time) {
          const progress = (time - start) / 12000;
          if (progress >= 1) {
            resolve();
            return;
          }
          const position = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
          window.scrollTo({ top: distance * position, behavior: 'instant' });
          requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
      state.active = false;
      await pause(1500);
      const entries = resources();
      const unique = new Set(entries.map((entry) => entry.name));
      const errors = state.samples.map((sample) => Math.abs(sample.actual - sample.desired));
      const percentile = (values, p) =>
        [...values].sort((a, b) => a - b)[
          Math.min(values.length - 1, Math.floor(values.length * p))
        ] || 0;
      return {
        readyAtMs,
        framesBeforeScroll,
        requests: entries.length,
        uniqueFrames: countFrames(unique),
        repeatRequests: entries.length - unique.size,
        transferredMB: +(entries.reduce((sum, entry) => sum + entry.transferSize, 0) / 1e6).toFixed(
          2,
        ),
        requestMsMedian: Math.round(
          percentile(
            entries.map((entry) => entry.duration),
            0.5,
          ),
        ),
        exactFramePercent: +(
          (100 * errors.filter((error) => error === 0).length) /
          errors.length
        ).toFixed(1),
        errorOver2FramesPercent: +(
          (100 * errors.filter((error) => error > 2).length) /
          errors.length
        ).toFixed(1),
        errorP95Frames: percentile(errors, 0.95),
        canvasDraws: state.draws,
        animationSamples: state.samples.length,
        rafMsP95: +percentile(
          state.samples.map((sample) => sample.gap),
          0.95,
        ).toFixed(1),
        rafOver50ms: state.samples.filter((sample) => sample.gap > 50).length,
        longTaskCount: state.longTasks.length,
      };
    });
    console.log(JSON.stringify({ url, run, mobile, throttled, ...result }));
  }
} finally {
  await browser.close();
}
