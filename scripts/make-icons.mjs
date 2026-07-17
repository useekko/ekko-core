// Generate Ekko's Balanced Packet E icons as PNGs, using only Node's built-in
// zlib. No image dependency. Deterministic.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const INK = [0x12, 0x14, 0x19];
const PEARL = [0xf7, 0xf3, 0xed];
const CORAL = [0xff, 0x5f, 0x52];

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, index) => {
    const entry = index * 16;
    directory[entry] = size >= 256 ? 0 : size;
    directory[entry + 1] = size >= 256 ? 0 : size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ data }) => data)]);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
// Rounded-rect signed distance (negative inside).
function rrsd(x, y, s, r) {
  const qx = Math.abs(x - s / 2) - (s / 2 - r);
  const qy = Math.abs(y - s / 2) - (s / 2 - r);
  const ox = Math.max(qx, 0),
    oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function roundedRectCoverage(px, py, x, y, width, height, radius, aa = 1) {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const qx = Math.abs(px - cx) - (width / 2 - radius);
  const qy = Math.abs(py - cy) - (height / 2 - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const distance = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
  return clamp01(-distance / aa + 0.5);
}

function circleCoverage(px, py, cx, cy, radius, aa = 1) {
  return clamp01((radius - Math.hypot(px - cx, py - cy)) / aa + 0.5);
}

// One geometry, two tiles: the extension uses the night surface and the site
// favicon/touch icon uses the warm pearl surface. The coral Packet E stays the
// same everywhere.
const EXTENSION = {
  bg: INK,
  fg: CORAL,
};
const SITE = {
  bg: PEARL,
  fg: CORAL,
};

function render(size, look = EXTENSION) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1;
  // iOS masks app icons itself, so that tile is drawn square (corner: 0) and full-bleed.
  const corner = size * (look.corner ?? 0.23);
  // glyphScale < 1 insets the mark inside the tile. iOS crops app icons to a squircle, so the
  // full-bleed mark the browser toolbar wants would have its stem shaved off on the home screen.
  const s = (size / 48) * (look.glyphScale ?? 1);
  const off = (size - 48 * s) / 2;
  const shapes = [
    [5, 4, 9, 40, 4.5],
    [17, 4, 27, 9, 4.5],
    [17, 19.5, 19, 9, 4.5],
    [17, 35, 27, 9, 4.5],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inTile = clamp01(-rrsd(x + 0.5, y + 0.5, size, corner) / aa + 0.5);
      let r = look.bg[0],
        g = look.bg[1],
        b = look.bg[2];
      let acc = circleCoverage(x + 0.5, y + 0.5, off + 42 * s, off + 24 * s, 3 * s, aa);
      for (const [sx, sy, width, height, radius] of shapes) {
        acc = Math.max(
          acc,
          roundedRectCoverage(
            x + 0.5, y + 0.5, off + sx * s, off + sy * s, width * s, height * s, radius * s, aa),
        );
      }
      r = Math.round(r + (look.fg[0] - r) * acc);
      g = Math.round(g + (look.fg[1] - g) * acc);
      b = Math.round(b + (look.fg[2] - b) * acc);
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(255 * inTile);
    }
  }
  return png(rgba, size);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const out = new URL(`../icons/icon${size}.png`, import.meta.url);
  writeFileSync(out, render(size));
  console.log('wrote', out.pathname);
}

// The website shares the same generated mark: apple-touch-icon (iOS home screen /
// Safari pinned) and a PNG favicon fallback for clients that skip the inline SVG.
mkdirSync(new URL('../site/assets/', import.meta.url), { recursive: true });
for (const [size, name] of [
  [180, 'apple-touch-icon.png'],
  [96, 'favicon-96.png'],
  [32, 'favicon-32.png'],
]) {
  const out = new URL(`../site/assets/${name}`, import.meta.url);
  writeFileSync(out, render(size, SITE));
  console.log('wrote', out.pathname);
}

const faviconImages = [16, 32, 48].map((size) => ({ size, data: render(size, SITE) }));
const favicon = new URL('../site/favicon.ico', import.meta.url);
writeFileSync(favicon, ico(faviconImages));
console.log('wrote', favicon.pathname);

// The iOS app icon is the same mark on the night surface, drawn SQUARE: iOS applies its own
// corner mask, and a pre-rounded icon would show a dark halo inside it.
const IOS = { bg: INK, fg: CORAL, corner: 0, glyphScale: 0.78 };
const iosIcon = new URL('../ios/Ekko/Assets.xcassets/AppIcon.appiconset/icon-1024.png', import.meta.url);
mkdirSync(new URL('./', iosIcon), { recursive: true });
writeFileSync(iosIcon, render(1024, IOS));
console.log('wrote', iosIcon.pathname);
