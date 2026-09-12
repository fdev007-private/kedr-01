export const FRAME_COUNT = 240;
export const FRAME_PACK_SIZE = 16;
export const FRAME_PACK_VERSION = 'v1';

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function progressToFrame(progress, count = FRAME_COUNT) {
  return Math.round(clamp(progress) * (count - 1));
}

export function scrollProgress(top, sectionHeight, viewportHeight) {
  const distance = sectionHeight - viewportHeight;
  return distance > 0 ? clamp(-top / distance) : 0;
}

export function frameSource(index, variant = 'desktop', base = '/') {
  const number = String(Math.round(clamp(index, 0, FRAME_COUNT - 1)) + 1).padStart(4, '0');
  return `${base.replace(/\/?$/, '/')}media/frames/${variant}/frame-${number}.webp`;
}

export function chapterAt(progress) {
  return progress < 0.42 ? 0 : progress < 0.73 ? 1 : 2;
}

export function nearestLoadedFrame(frames, desired) {
  if (frames.has(desired)) return desired;
  for (let distance = 1; distance < FRAME_COUNT; distance++) {
    if (frames.has(desired - distance)) return desired - distance;
    if (frames.has(desired + distance)) return desired + distance;
  }
  return null;
}

const ANCHORS = Array.from({ length: 8 }, (_, index) => index * 32);

export function framePackSource(pack, variant = 'desktop', base = '/') {
  return `${base.replace(/\/?$/, '/')}media/packs/${FRAME_PACK_VERSION}/${variant}/pack-${String(pack + 1).padStart(4, '0')}.bin`;
}

export function unpackFrames(buffer, firstFrame) {
  if (
    !Number.isInteger(firstFrame) ||
    firstFrame < 0 ||
    firstFrame >= FRAME_COUNT ||
    firstFrame % FRAME_PACK_SIZE !== 0
  )
    throw new Error('Invalid frame pack index');
  const view = new DataView(buffer);
  const result = new Map();
  let offset = 0;
  const count = Math.min(FRAME_PACK_SIZE, FRAME_COUNT - firstFrame);
  for (let index = firstFrame; index < firstFrame + count; index++) {
    if (
      offset + 12 > view.byteLength ||
      view.getUint32(offset, true) !== 0x46464952 ||
      view.getUint32(offset + 8, true) !== 0x50424557
    )
      throw new Error('Invalid WebP frame pack');
    const size = view.getUint32(offset + 4, true) + 8;
    if (size < 12 || offset + size > view.byteLength) throw new Error('Truncated WebP frame pack');
    result.set(index, new Blob([new Uint8Array(buffer, offset, size)], { type: 'image/webp' }));
    offset += size;
  }
  if (offset !== view.byteLength || count <= 0)
    throw new Error('Unexpected WebP frame pack length');
  return result;
}

export function framePriority(target, direction = 1, ahead = 48, behind = 8) {
  const indices = [target];
  // A small reverse buffer handles a change of direction without waiting for the network.
  for (let offset = 1; offset <= ahead; offset++) {
    indices.push(target + offset * direction);
    if (offset <= behind) indices.push(target - offset * direction);
  }
  return [...new Set(indices)].filter((index) => index >= 0 && index < FRAME_COUNT);
}

async function downloadPack(url, signal, firstFrame) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Frame request failed: ${response.status}`);
  return unpackFrames(await response.arrayBuffer(), firstFrame);
}

export async function decodeFrame(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* Older engines can still decode the same WebP through an image element. */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const picture = new Image();
    picture.decoding = 'async';
    picture.src = url;
    await picture.decode();
    return picture;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class FrameSequence {
  constructor({
    variant,
    onFrame,
    onProgress,
    concurrency = 3,
    base = '/',
    fetchPack = downloadPack,
    prepareFrame = decodeFrame,
  }) {
    this.variant = variant;
    this.base = base;
    this.onFrame = onFrame;
    this.onProgress = onProgress;
    this.concurrency = concurrency;
    this.fetchPack = fetchPack;
    this.prepareFrame = prepareFrame;
    // Keep the small compressed files, not 240 full-size decoded surfaces.
    this.blobs = new Map();
    this.frames = new Map();
    this.cacheLimit = variant === 'mobile' ? 28 : 40;
    this.decodeAhead = variant === 'mobile' ? 14 : 26;
    this.pending = new Set();
    this.decoding = new Set();
    this.failed = new Set();
    this.decodeFailed = new Set();
    this.queue = [];
    this.target = 0;
    this.direction = 1;
    this.displayedFrame = null;
    this.destroyed = false;
    this.started = false;
    this.controller = new AbortController();
  }

  start() {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.queue = Array.from({ length: Math.ceil(FRAME_COUNT / FRAME_PACK_SIZE) }, (_, i) => i);
    this.prioritize();
  }

  setTarget(index) {
    if (this.destroyed) return;
    const next = Math.round(clamp(index, 0, FRAME_COUNT - 1));
    if (next !== this.target) this.direction = Math.sign(next - this.target);
    this.target = next;
    if (this.started) this.prioritize();
  }

  prioritize() {
    const nearbyPacks = framePriority(this.target, this.direction).map((index) =>
      Math.floor(index / FRAME_PACK_SIZE),
    );
    this.queue = [...new Set([...nearbyPacks, ...this.queue])].filter(
      (index) =>
        !this.blobs.has(index * FRAME_PACK_SIZE) &&
        !this.pending.has(index) &&
        !this.failed.has(index),
    );
    this.pumpDownloads();
    this.pumpDecodes();
  }

  pumpDownloads() {
    while (!this.destroyed && this.pending.size < this.concurrency && this.queue.length) {
      const index = this.queue.shift();
      this.pending.add(index);
      void this.load(index);
    }
  }

  async load(index) {
    try {
      const pack = await this.fetchPack(
        framePackSource(index, this.variant, this.base),
        this.controller.signal,
        index * FRAME_PACK_SIZE,
      );
      if (this.destroyed) return;
      for (const [frame, blob] of pack) this.blobs.set(frame, blob);
      this.onProgress?.(this.blobs.size, FRAME_COUNT);
    } catch {
      if (!this.destroyed) this.failed.add(index);
    } finally {
      this.pending.delete(index);
      if (!this.destroyed) {
        this.pumpDownloads();
        this.pumpDecodes();
      }
    }
  }

  decodePriority() {
    const nearest = nearestLoadedFrame(this.blobs, this.target);
    return [
      ...new Set([
        ...(nearest === null ? [] : [nearest]),
        ...framePriority(this.target, this.direction, this.decodeAhead, 5),
        ...ANCHORS,
      ]),
    ].slice(0, this.cacheLimit);
  }

  pumpDecodes() {
    if (this.destroyed) return;
    const wanted = this.decodePriority();
    // Limit decoding independently of network concurrency to avoid CPU bursts on phones.
    for (const index of wanted) {
      if (this.decoding.size >= 2) break;
      if (
        !this.blobs.has(index) ||
        this.frames.has(index) ||
        this.decoding.has(index) ||
        this.decodeFailed.has(index)
      )
        continue;
      this.decoding.add(index);
      void this.prepare(index);
    }
  }

  async prepare(index) {
    try {
      const picture = await this.prepareFrame(this.blobs.get(index));
      if (this.destroyed || !this.decodePriority().includes(index)) {
        picture.close?.();
        return;
      }
      const previous = nearestLoadedFrame(this.frames, this.target);
      this.frames.set(index, picture);
      this.prune();
      if (previous !== nearestLoadedFrame(this.frames, this.target)) this.onFrame?.();
    } catch {
      if (!this.destroyed) this.decodeFailed.add(index);
    } finally {
      this.decoding.delete(index);
      this.pumpDecodes();
    }
  }

  current() {
    this.displayedFrame = nearestLoadedFrame(this.frames, this.target);
    return this.displayedFrame === null ? null : this.frames.get(this.displayedFrame);
  }

  prune() {
    const priority = this.decodePriority();
    const wanted = new Set(priority);
    // Drop obsolete surfaces first; retained compressed blobs make revisits network-free.
    const removable = [...this.frames.keys()].sort((a, b) => {
      const rank = (index) =>
        wanted.has(index) ? priority.indexOf(index) : FRAME_COUNT + Math.abs(index - this.target);
      return rank(b) - rank(a);
    });
    while (this.frames.size > this.cacheLimit) {
      const index = removable.shift();
      this.frames.get(index).close?.();
      this.frames.delete(index);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.abort();
    this.queue = [];
    for (const picture of this.frames.values()) picture.close?.();
    this.frames.clear();
    this.blobs.clear();
  }
}
