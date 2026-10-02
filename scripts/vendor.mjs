// Copies pinned third-party files into public/vendor and builds public/icons.svg.
// Run after changing versions or the icon list: `npm run vendor`. Outputs are committed.
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_ICONS, UI_ICONS } from '../public/js/icon-list.js';

const root = path.resolve(import.meta.dirname, '..');
const nm = p => path.join(root, 'node_modules', p);
const out = p => path.join(root, 'public', p);

fs.mkdirSync(out('vendor/fonts'), { recursive: true });

const copies = [
  ['@knadh/oat/oat.min.css', 'vendor/oat.min.css'],
  ['@knadh/oat/oat.min.js', 'vendor/oat.min.js'],
  ['charts.css/dist/charts.min.css', 'vendor/charts.min.css'],
  ['@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2', 'vendor/fonts/manrope-latin.woff2'],
  ['@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2', 'vendor/fonts/manrope-latin-ext.woff2'],
];
for (const [from, to] of copies) fs.copyFileSync(nm(from), out(to));

// SVG sprite: <use href="/icons.svg#name"> anywhere in the app
const names = [...new Set([...CATEGORY_ICONS.map(i => i.name), ...UI_ICONS])].sort();
const symbols = names.map(name => {
  const svg = fs.readFileSync(nm(`lucide-static/icons/${name}.svg`), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '');
  // presentation attributes live on each <symbol>: <use> clones inherit from it, not from the sprite root
  return `<symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`;
});
fs.writeFileSync(out('icons.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>\n`);

console.log(`vendored ${copies.length} files, ${names.length} icons -> public/icons.svg (${(fs.statSync(out('icons.svg')).size / 1024).toFixed(1)} KB)`);
