// Copies the web fonts into public/fonts and builds public/icons.svg, a sprite
// with only the Material Symbols icons the templates and scripts use.
// Run with `npm run build` (the output is committed, so servers need no build).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = path.join(root, 'node_modules');
const out = path.join(root, 'public');

function copyFonts() {
  const dest = path.join(out, 'fonts');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  for (const weight of [400, 500, 600, 700]) {
    files.push(['@fontsource/hind-siliguri/files', `hind-siliguri-bengali-${weight}-normal.woff2`]);
  }
  for (const subset of ['latin', 'latin-ext']) {
    files.push(['@fontsource-variable/inter/files', `inter-${subset}-wght-normal.woff2`]);
  }
  for (const [dir, file] of files) {
    fs.copyFileSync(path.join(modules, dir, file), path.join(dest, file));
  }
  console.log(`Copied ${files.length} font files.`);
}

function listFiles(dir, pattern) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, pattern));
    else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

function buildIcons() {
  const sources = [
    ...listFiles(path.join(root, 'views'), /\.ejs$/),
    ...listFiles(path.join(root, 'public', 'js'), /\.js$/)
  ];
  const names = new Set();
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/icon\(\s*['"]([a-z0-9_]+(?:-fill)?)['"]/g)) {
      names.add(match[1]);
    }
    // Icons chosen at runtime are listed in a comment: "icons: name another_name"
    for (const match of text.matchAll(/icons:((?:\s+[a-z0-9_]+(?:-fill)?)+)/g)) {
      match[1].trim().split(/\s+/).forEach(n => names.add(n));
    }
  }
  const svgDir = path.join(modules, '@material-symbols', 'svg-400', 'outlined');
  const symbols = [];
  for (const name of [...names].sort()) {
    const file = path.join(svgDir, `${name}.svg`);
    if (!fs.existsSync(file)) {
      throw new Error(`Unknown icon "${name}" (no ${file})`);
    }
    const svg = fs.readFileSync(file, 'utf8');
    const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    symbols.push(`<symbol id="${name}" viewBox="${viewBox}">${inner}</symbol>`);
  }
  fs.writeFileSync(path.join(out, 'icons.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg"><!-- Material Symbols (Apache License 2.0) -->${symbols.join('')}</svg>\n`);
  console.log(`Built icon sprite with ${symbols.length} icons.`);
}

copyFonts();
buildIcons();
