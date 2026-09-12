import test from 'node:test';
import assert from 'node:assert/strict';
import {
  progressToFrame,
  scrollProgress,
  frameSource,
  chapterAt,
  nearestLoadedFrame,
  FrameSequence,
  framePriority,
  framePackSource,
  unpackFrames,
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

test('prefetch looks ahead in either scroll direction without invalid or duplicate indices', () => {
  assert.deepEqual(framePriority(100, 1, 3, 1), [100, 101, 99, 102, 103]);
  assert.deepEqual(framePriority(100, -1, 3, 1), [100, 99, 101, 98, 97]);
  for (const target of [0, 120, 239]) {
    const indices = framePriority(target);
    assert.equal(new Set(indices).size, indices.length);
    assert.ok(indices.every((index) => index >= 0 && index < 240));
  }
});

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), 'Asynchronous frame work did not settle');
}

function fakePack(first) {
  return new Map(
    Array.from({ length: 16 }, (_, offset) => [first + offset, { index: first + offset }]),
  );
}

function fixture(options = {}) {
  const requests = [];
  const pictures = [];
  const sequence = new FrameSequence({
    variant: 'mobile',
    fetchPack: async (url) => {
      const index = Number(url.match(/pack-(\d+)/)[1]) - 1;
      requests.push(index);
      return fakePack(index * 16);
    },
    prepareFrame: async ({ index }) => {
      const picture = {
        index,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      pictures.push(picture);
      return picture;
    },
    ...options,
  });
  return { sequence, requests, pictures };
}

test('revisiting discarded decoded frames never downloads the compressed files again', async () => {
  const { sequence, requests, pictures } = fixture();
  try {
    sequence.start();
    sequence.start();
    await until(() => sequence.blobs.size === 240 && sequence.decoding.size === 0);
    assert.equal(requests.length, 15);
    assert.equal(new Set(requests).size, 15);
    for (const target of [200, 10, 239, 80, 0]) {
      sequence.setTarget(target);
      await until(() => sequence.frames.has(target) && sequence.decoding.size === 0);
      assert.equal(sequence.current().index, target);
      assert.ok(sequence.frames.size <= 28);
      assert.ok([...sequence.frames.values()].every((picture) => !picture.closed));
    }
    assert.equal(requests.length, 15);
    assert.ok(pictures.some((picture) => picture.closed));
  } finally {
    sequence.destroy();
  }
  assert.ok(pictures.every((picture) => picture.closed));
  assert.equal(sequence.blobs.size, 0);
});

test('a chapter jump takes the next free network slot, ahead of obsolete queued work', async () => {
  const pending = [];
  const { sequence } = fixture({
    concurrency: 2,
    fetchPack: (url) => new Promise((resolve) => pending.push({ url, resolve })),
  });
  try {
    sequence.start();
    assert.equal(pending.length, 2);
    sequence.setTarget(200);
    pending[0].resolve(fakePack(0));
    await until(() => pending.length === 3);
    assert.match(pending[2].url, /pack-0013.bin$/);
    assert.equal(sequence.pending.size, 2);
  } finally {
    sequence.destroy();
    for (const request of pending) request.resolve(fakePack(0));
  }
});

test('destroy aborts requests and closes late decoded surfaces without callbacks', async () => {
  const finishDecodes = [];
  let signal;
  let notifications = 0;
  const picture = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const { sequence } = fixture({
    fetchPack: async (_url, requestSignal) => {
      signal = requestSignal;
      return fakePack(0);
    },
    prepareFrame: () =>
      new Promise((resolve) => {
        finishDecodes.push(resolve);
      }),
    onFrame: () => notifications++,
  });
  sequence.start();
  await until(() => finishDecodes.length === 2);
  sequence.destroy();
  assert.equal(signal.aborted, true);
  for (const finishDecode of finishDecodes) finishDecode(picture);
  await until(() => picture.closed && sequence.decoding.size === 0);
  assert.equal(notifications, 0);
  assert.equal(sequence.frames.size, 0);
  assert.equal(sequence.blobs.size, 0);
});

test('failed downloads and corrupt frames leave the closest usable fallback without retry loops', async () => {
  const { sequence, requests } = fixture({
    fetchPack: async (url) => {
      const index = Number(url.match(/pack-(\d+)/)[1]) - 1;
      requests.push(index);
      if (index === 1) throw new Error('offline');
      return fakePack(index * 16);
    },
    prepareFrame: async ({ index }) => {
      if (index === 2) throw new Error('corrupt WebP');
      return { index, close() {} };
    },
  });
  try {
    sequence.start();
    await until(() => sequence.pending.size === 0 && sequence.decoding.size === 0);
    sequence.setTarget(17);
    await until(() => sequence.decoding.size === 0);
    assert.equal(sequence.current().index, 15);
    assert.equal(requests.filter((index) => index === 1).length, 1);
    assert.equal(sequence.failed.has(1), true);
    assert.equal(sequence.decodeFailed.has(2), true);
  } finally {
    sequence.destroy();
  }
});

test('packed WebP frames preserve bytes and reject truncated or malformed packets', async () => {
  assert.equal(
    framePackSource(14, 'mobile', '/gpt-land/'),
    '/gpt-land/media/packs/v1/mobile/pack-0015.bin',
  );
  const buffer = new ArrayBuffer(16 * 12);
  const view = new DataView(buffer);
  for (let offset = 0; offset < buffer.byteLength; offset += 12) {
    view.setUint32(offset, 0x46464952, true);
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, 0x50424557, true);
  }
  const frames = unpackFrames(buffer, 224);
  assert.equal(frames.size, 16);
  assert.equal(frames.get(239).type, 'image/webp');
  assert.deepEqual(
    new Uint8Array(await frames.get(224).arrayBuffer()),
    new Uint8Array(buffer, 0, 12),
  );
  assert.throws(() => unpackFrames(buffer.slice(0, -1), 0), /Truncated|Invalid/);
  assert.throws(() => unpackFrames(new ArrayBuffer(192), 0), /Invalid/);
  assert.throws(() => unpackFrames(buffer, -1), /Invalid/);
  assert.throws(() => unpackFrames(buffer, 240), /Invalid/);
});
