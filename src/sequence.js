export const FRAME_COUNT = 240;

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

export class FrameSequence {
  constructor({ variant, onFrame, onProgress, concurrency = 4, base = '/' }) {
    this.variant = variant;
    this.base = base;
    this.onFrame = onFrame;
    this.onProgress = onProgress;
    this.concurrency = concurrency;
    this.frames = new Map();
    this.loaded = new Set();
    this.cacheLimit = variant === 'mobile' ? 28 : 40;
    this.failed = new Set();
    this.pending = new Set();
    this.queue = [];
    this.active = 0;
    this.target = 0;
    this.destroyed = false;
    this.started = false;
  }

  start() {
    if (this.started || this.destroyed) return;
    this.started = true;
    // Sparse keyframes make long scroll jumps useful before all frames arrive.
    this.enqueue([
      0,
      ...Array.from({ length: 30 }, (_, i) => i * 8),
      ...Array.from({ length: FRAME_COUNT }, (_, i) => i),
    ]);
  }

  enqueue(indices, priority = false) {
    const wanted = [...new Set(indices)].filter(
      (index) =>
        index >= 0 &&
        index < FRAME_COUNT &&
        !this.frames.has(index) &&
        !this.pending.has(index) &&
        !this.failed.has(index),
    );
    const wantedSet = new Set(wanted);
    const remainder = this.queue.filter((index) => !wantedSet.has(index));
    this.queue = priority ? [...wanted, ...remainder] : [...remainder, ...wanted];
    this.pump();
  }

  setTarget(index) {
    this.target = Math.round(clamp(index, 0, FRAME_COUNT - 1));
    const neighborhood = [this.target];
    for (let offset = 1; offset <= 6; offset++)
      neighborhood.push(this.target + offset, this.target - offset);
    this.enqueue(neighborhood, true);
    this.onFrame();
  }

  pump() {
    while (!this.destroyed && this.active < this.concurrency && this.queue.length) {
      const index = this.queue.shift();
      if (this.frames.has(index) || this.pending.has(index) || this.failed.has(index)) continue;
      this.active++;
      this.pending.add(index);
      const picture = new Image();
      picture.decoding = 'async';
      picture.onload = () => {
        if (this.destroyed) return;
        this.frames.set(index, picture);
        this.loaded.add(index);
        this.prune();
        this.finish(index);
        this.onFrame();
      };
      picture.onerror = () => {
        if (this.destroyed) return;
        this.failed.add(index);
        this.finish(index);
      };
      picture.src = frameSource(index, this.variant, this.base);
    }
  }

  finish(index) {
    this.active--;
    this.pending.delete(index);
    this.onProgress?.(this.loaded.size, FRAME_COUNT);
    this.pump();
  }

  current() {
    const index = nearestLoadedFrame(this.frames, this.target);
    return index === null ? null : this.frames.get(index);
  }

  prune() {
    if (this.frames.size <= this.cacheLimit) return;
    const ranked = [...this.frames.keys()].sort((a, b) => {
      const score = (index) => Math.abs(index - this.target) - (index % 24 === 0 ? 60 : 0);
      return score(b) - score(a);
    });
    for (const index of ranked.slice(0, this.frames.size - this.cacheLimit))
      this.frames.delete(index);
  }

  destroy() {
    this.destroyed = true;
    this.queue = [];
    this.frames.clear();
  }
}
