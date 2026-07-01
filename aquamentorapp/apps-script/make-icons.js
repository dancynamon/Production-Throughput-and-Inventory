/* Generates icon-192.png and icon-512.png with no dependencies.
 * Draws a navy rounded square with a gold "stacked inventory boxes" mark.
 * Run once:  node apps-script/make-icons.js   (writes into the inventory/ folder)
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const NAVY = [12, 31, 63];      // #0c1f3f
const GOLD = [201, 169, 110];   // #c9a96e
const CREAM = [247, 246, 243];  // #f7f6f3

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
  };
  // Rounded-square background
  const rad = size * 0.22;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inCorner =
      (x < rad && y < rad && (x - rad) ** 2 + (y - rad) ** 2 > rad * rad) ||
      (x > size - rad && y < rad && (x - (size - rad)) ** 2 + (y - rad) ** 2 > rad * rad) ||
      (x < rad && y > size - rad && (x - rad) ** 2 + (y - (size - rad)) ** 2 > rad * rad) ||
      (x > size - rad && y > size - rad && (x - (size - rad)) ** 2 + (y - (size - rad)) ** 2 > rad * rad);
    if (!inCorner) set(x, y, NAVY);
  }
  // Three stacked boxes (inventory)
  const u = size / 16;
  const box = (cx, cy, w, h, fill, border) => {
    const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
    rect(x0, y0, Math.round(w), Math.round(h), fill);
    const b = Math.max(2, Math.round(u * 0.18));
    rect(x0, y0, Math.round(w), b, border);
    rect(x0, y0 + Math.round(h) - b, Math.round(w), b, border);
    rect(x0, y0, b, Math.round(h), border);
    rect(x0 + Math.round(w) - b, y0, b, Math.round(h), border);
    rect(x0, Math.round(cy - b / 2), Math.round(w), b, border); // center seam
  };
  box(size * 0.5,  size * 0.68, u * 8.5, u * 3.6, GOLD, NAVY);          // bottom wide
  box(size * 0.38, size * 0.40, u * 4.6, u * 3.4, CREAM, NAVY);         // top-left
  box(size * 0.63, size * 0.42, u * 4.2, u * 3.0, GOLD, NAVY);          // top-right
  return buf;
}

function writePng(file, size) {
  const raw = draw(size);
  // Add PNG filter byte (0) at the start of each row
  const rowLen = size * 4;
  const filtered = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (rowLen + 1)] = 0;
    raw.copy(filtered, y * (rowLen + 1) + 1, y * rowLen, y * rowLen + rowLen);
  }
  const idat = zlib.deflateSync(filtered, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  console.log('wrote', file, png.length, 'bytes');
}

// CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}

const outDir = path.join(__dirname, '..');
writePng(path.join(outDir, 'icon-192.png'), 192);
writePng(path.join(outDir, 'icon-512.png'), 512);
