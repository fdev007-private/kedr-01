import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  FRAME_COUNT,
  FRAME_PACK_SIZE,
  framePackSource,
  frameSource,
  unpackFrames,
} from '../src/sequence.js';

let totalBytes = 0;
for (const variant of ['desktop', 'mobile']) {
  for (let first = 0; first < FRAME_COUNT; first += FRAME_PACK_SIZE) {
    const frames = await Promise.all(
      Array.from({ length: Math.min(FRAME_PACK_SIZE, FRAME_COUNT - first) }, (_, offset) =>
        readFile(new URL(`../public${frameSource(first + offset, variant)}`, import.meta.url)),
      ),
    );
    // WebP's RIFF length lets the browser split this lossless concatenation without a ZIP dependency.
    const packed = Buffer.concat(frames);
    unpackFrames(
      packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
      first,
    );
    const destination = new URL(
      `../public${framePackSource(first / FRAME_PACK_SIZE, variant)}`,
      import.meta.url,
    );
    await mkdir(new URL('./', destination), { recursive: true });
    await writeFile(destination, packed);
    totalBytes += packed.length;
  }
}
console.log(
  `Frame packs: ${Math.ceil(FRAME_COUNT / FRAME_PACK_SIZE)} per viewport, ${(totalBytes / 1e6).toFixed(2)} MB, original WebP bytes preserved.`,
);
