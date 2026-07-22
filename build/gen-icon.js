// Generates build/icon.ico (multi-size) + build/icon-256.png from build/icon.svg
// Usage: node build/gen-icon.js   (requires devDeps: sharp, png-to-ico)
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'));
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const pngs = [];
  for (const s of sizes) {
    pngs.push(await sharp(svg).resize(s, s).png().toBuffer());
  }
  fs.writeFileSync(path.join(__dirname, 'icon-256.png'), pngs[pngs.length - 1]);
  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
  console.log('icon.ico written:', ico.length, 'bytes; sizes:', sizes.join(','));
})().catch((e) => { console.error(e); process.exit(1); });
