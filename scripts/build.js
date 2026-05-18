/**
 * Build reveal.js slide decks into self-contained HTML (and optionally PDF).
 * Node.js port of build.py — works on Windows without Python.
 *
 * Usage:
 *   node scripts/build.js                        # build all decks (html + pdf)
 *   node scripts/build.js croqtile-intro          # build one deck
 *   node scripts/build.js --format html           # HTML only
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DECKS_DIR = path.join(REPO_ROOT, 'decks');
const FORMATS = ['html', 'pdf'];

function findDecks() {
  if (!fs.existsSync(DECKS_DIR)) return [];
  return fs.readdirSync(DECKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(DECKS_DIR, d.name, 'index.html')))
    .map(d => d.name)
    .sort();
}

function resolveLocalPath(href, baseDir) {
  if (/^https?:\/\//.test(href) || href.startsWith('data:')) return null;
  const decoded = decodeURIComponent(href);
  const resolved = path.resolve(baseDir, decoded);
  return fs.existsSync(resolved) ? resolved : null;
}

function inlineCssFile(cssPath) {
  let css = fs.readFileSync(cssPath, 'utf-8');
  const cssDir = path.dirname(cssPath);
  css = css.replace(/url\(([^)]+)\)/g, (match, rawUrl) => {
    const url = rawUrl.replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:') || url.startsWith('http')) return match;
    const local = resolveLocalPath(url, cssDir);
    if (!local) return match;
    const mime = guessMime(local);
    const data = fs.readFileSync(local).toString('base64');
    return `url("data:${mime};base64,${data}")`;
  });
  return css;
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

function buildSelfContainedHtml(deckPath, outputPath) {
  let html = fs.readFileSync(deckPath, 'utf-8');
  const baseDir = path.dirname(deckPath);

  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>/g, (match, href) => {
    const local = resolveLocalPath(href, baseDir);
    if (!local) return match;
    const css = inlineCssFile(local);
    return `<style>\n${css}\n</style>`;
  });

  html = html.replace(/<script\s+src="([^"]+)"[^>]*><\/script>/g, (match, src) => {
    const local = resolveLocalPath(src, baseDir);
    if (!local) return match;
    const js = fs.readFileSync(local, 'utf-8');
    return `<script>\n${js}\n</script>`;
  });

  html = html.replace(/<img\s[^>]*src="([^"]+)"[^>]*>/g, (match, src) => {
    const local = resolveLocalPath(src, baseDir);
    if (!local) return match;
    const mime = guessMime(local);
    const data = fs.readFileSync(local).toString('base64');
    return match.replace(`src="${src}"`, `src="data:${mime};base64,${data}"`);
  });

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log(`  OK: ${path.relative(REPO_ROOT, outputPath)}`);
}

function buildPdf(htmlPath, outputPath) {
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  console.log(`  Building PDF via decktape ...`);
  try {
    execSync(
      `npx decktape reveal "file:///${htmlPath.replace(/\\/g, '/')}" "${outputPath}" --size 792x612`,
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );
    console.log(`  OK: ${path.relative(REPO_ROOT, outputPath)}`);
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    console.error(`  PDF ERROR: ${stderr}`);
    if (/puppeteer|chrome/i.test(stderr)) {
      console.error('  Hint: PDF export requires Chrome. Install with: npx puppeteer browsers install chrome');
    }
  }
}

function buildDeck(deckName, formats) {
  const deckPath = path.join(DECKS_DIR, deckName, 'index.html');
  const distDir = path.join(DECKS_DIR, deckName, 'dist');

  for (const fmt of formats) {
    if (fmt === 'html') {
      buildSelfContainedHtml(deckPath, path.join(distDir, 'slides.html'));
    } else if (fmt === 'pdf') {
      const htmlOut = path.join(distDir, 'slides.html');
      if (!fs.existsSync(htmlOut)) {
        buildSelfContainedHtml(deckPath, htmlOut);
      }
      buildPdf(htmlOut, path.join(distDir, 'slides.pdf'));
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  let target = null;
  let formats = FORMATS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format' && i + 1 < args.length) {
      formats = args[++i].split(',');
    } else if (!args[i].startsWith('-')) {
      target = args[i];
    }
  }

  if (target) {
    const deckPath = path.join(DECKS_DIR, target, 'index.html');
    if (!fs.existsSync(deckPath)) {
      console.error(`Deck not found: ${deckPath}`);
      process.exit(1);
    }
    console.log(`Building deck: ${target}`);
    buildDeck(target, formats);
  } else {
    const decks = findDecks();
    if (decks.length === 0) {
      console.log('No decks found in decks/');
      process.exit(0);
    }
    console.log(`Found ${decks.length} deck(s)`);
    for (const name of decks) {
      console.log(`\nBuilding deck: ${name}`);
      buildDeck(name, formats);
    }
  }
  console.log('\nDone.');
}

main();
