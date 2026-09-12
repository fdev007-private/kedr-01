import { access, readdir } from 'node:fs/promises';

for (const variant of ['desktop', 'mobile']) {
  const files = await readdir(new URL(`../public/media/frames/${variant}/`, import.meta.url));
  for (let frame = 1; frame <= 240; frame++) {
    const filename = `frame-${String(frame).padStart(4, '0')}.webp`;
    if (!files.includes(filename)) throw new Error(`Missing ${variant}/${filename}`);
  }
}
for (const filename of ['poster.webp', 'exploded.webp', 'rear.webp', 'film.mp4']) {
  await access(new URL(`../public/media/${filename}`, import.meta.url));
}
await access(new URL('../public/fonts-licenses.txt', import.meta.url));
console.log('Assets: 480 animation frames, three stills, film and font licenses verified.');
