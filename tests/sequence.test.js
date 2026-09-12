import test from 'node:test';
import assert from 'node:assert/strict';
import {
  progressToFrame,
  scrollProgress,
  frameSource,
  chapterAt,
  nearestLoadedFrame,
} from '../src/sequence.js';

test('scroll position stays inside the exported sequence, including overscroll', () => {
  assert.equal(progressToFrame(-1), 0);
  assert.equal(progressToFrame(1), 239);
  assert.equal(progressToFrame(12), 239);
  assert.equal(progressToFrame(NaN), 0);
  assert.equal(scrollProgress(200, 6000, 1000), 0);
  assert.equal(scrollProgress(-2500, 6000, 1000), 0.5);
  assert.equal(scrollProgress(-9000, 6000, 1000), 1);
  assert.equal(scrollProgress(-1, 500, 800), 0);
});

test('frame URLs use valid exported indices on both screen sizes', () => {
  assert.equal(frameSource(0), '/media/frames/desktop/frame-0001.webp');
  assert.equal(frameSource(239, 'mobile'), '/media/frames/mobile/frame-0240.webp');
  assert.equal(frameSource(999), '/media/frames/desktop/frame-0240.webp');
});

test('frame URLs respect a GitHub Pages project prefix', () => {
  assert.equal(
    frameSource(0, 'desktop', '/gpt-land/'),
    '/gpt-land/media/frames/desktop/frame-0001.webp',
  );
  assert.equal(
    frameSource(239, 'mobile', '/gpt-land'),
    '/gpt-land/media/frames/mobile/frame-0240.webp',
  );
});

test('a fast scroll can display the closest downloaded image without a blank canvas', () => {
  const frames = new Map([
    [0, {}],
    [80, {}],
    [160, {}],
  ]);
  assert.equal(nearestLoadedFrame(frames, 147), 160);
  assert.equal(nearestLoadedFrame(frames, 83), 80);
  assert.equal(nearestLoadedFrame(new Map(), 83), null);
});

test('chapters follow the orbit, disassembly, and reassembly timeline', () => {
  assert.equal(chapterAt(0.41), 0);
  assert.equal(chapterAt(0.42), 1);
  assert.equal(chapterAt(0.73), 2);
  assert.equal(chapterAt(1), 2);
});
