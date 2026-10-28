// Regenerates the PNG icons from public/icon.svg (sharp ships with Next). Run: node scripts/make-icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url));
const square = Buffer.from(svg.toString().replace('rx="112"', 'rx="0"'));
const out = (p) => new URL(`../${p}`, import.meta.url).pathname;
await sharp(svg).resize(192, 192).png().toFile(out('public/icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(out('public/icon-512.png'));
await sharp(square).resize(512, 512).png().toFile(out('public/icon-maskable-512.png'));
// iOS rounds the corners itself, so the touch icon is full-bleed.
await sharp(square).resize(180, 180).png().toFile(out('app/apple-icon.png'));
console.log('icons written');
