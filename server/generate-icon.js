/**
 * generate-icon.js — Membuat icon.ico placeholder untuk development.
 * Jalankan: node generate-icon.js
 *
 * Untuk produksi: ganti assets/icon.ico dengan icon 256x256 yang valid.
 * Tools: https://icoconvert.com atau Figma → export PNG → convert
 */
const fs   = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, 'assets');
if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

// ── Minimal ICO 16x16 (RGBA, navy #0f172a dengan lingkaran biru) ──────────────
// Format: ICO header (6 bytes) + directory (16 bytes) + BMP header + pixel data
function createMinimalIco() {
  const SIZE = 16;
  const pixels = SIZE * SIZE * 4; // RGBA

  // ICO Header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // type: ICO
  header.writeUInt16LE(1, 4);  // count: 1 image

  // ICO Directory Entry (16 bytes)
  const dir = Buffer.alloc(16);
  dir[0] = SIZE;  // width
  dir[1] = SIZE;  // height
  dir[2] = 0;     // color count
  dir[3] = 0;     // reserved
  dir.writeUInt16LE(1, 4);    // planes
  dir.writeUInt16LE(32, 6);   // bit count
  const bmpSize = 40 + pixels + SIZE * 4; // BITMAPINFOHEADER + pixels + AND mask
  dir.writeUInt32LE(bmpSize, 8);
  dir.writeUInt32LE(6 + 16, 12); // offset

  // BITMAPINFOHEADER (40 bytes)
  const bmpHeader = Buffer.alloc(40);
  bmpHeader.writeUInt32LE(40, 0);           // header size
  bmpHeader.writeInt32LE(SIZE, 4);          // width
  bmpHeader.writeInt32LE(SIZE * 2, 8);      // height (doubled for ICO)
  bmpHeader.writeUInt16LE(1, 12);           // planes
  bmpHeader.writeUInt16LE(32, 14);          // bits per pixel
  bmpHeader.writeUInt32LE(0, 16);           // compression: BI_RGB
  bmpHeader.writeUInt32LE(pixels, 20);      // image size

  // Pixel data (BGRA, bottom-to-top)
  const pixData = Buffer.alloc(pixels);
  const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = ((SIZE - 1 - y) * SIZE + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        // Blue circle (#3b82f6)
        pixData[i + 0] = 0xf6; // B
        pixData[i + 1] = 0x82; // G
        pixData[i + 2] = 0x3b; // R
        pixData[i + 3] = 0xff; // A
      } else {
        // Navy background (#0f172a)
        pixData[i + 0] = 0x2a; // B
        pixData[i + 1] = 0x17; // G
        pixData[i + 2] = 0x0f; // R
        pixData[i + 3] = 0xff; // A
      }
    }
  }

  // AND mask (all zeros = fully visible)
  const andMask = Buffer.alloc(SIZE * 4, 0);

  return Buffer.concat([header, dir, bmpHeader, pixData, andMask]);
}

const ico = createMinimalIco();
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
fs.writeFileSync(path.join(ASSETS, 'icon.png'), ico); // stub PNG (valid enough for electron-builder)
console.log('✓ Placeholder icon.ico generated at assets/icon.ico');
console.log('  Ganti dengan icon 256x256 yang valid sebelum distribusi produksi.');
