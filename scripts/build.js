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
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');
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

function replaceAsync(text, pattern, replacer) {
  let regex = pattern;
  if (!regex.global) {
    regex = new RegExp(regex.source, `${regex.flags}g`);
  }

  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ index: match.index, match });
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }

  if (matches.length === 0) {
    return Promise.resolve(text);
  }

  return matches.reduce((promise, entry, idx) => promise.then(async (parts) => {
    const prevEnd = idx === 0 ? 0 : matches[idx - 1].index + matches[idx - 1].match[0].length;
    parts.push(text.slice(prevEnd, entry.index));
    parts.push(await replacer.apply(null, entry.match));
    if (idx === matches.length - 1) {
      parts.push(text.slice(entry.index + entry.match[0].length));
    }
    return parts;
  }), Promise.resolve([])).then(parts => parts.join(''));
}

function fetchRemoteBuffer(url, redirects) {
  const redirectCount = redirects || 0;
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects for ${url}`));
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        resolve(fetchRemoteBuffer(nextUrl, redirectCount + 1));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: response.headers['content-type'] || '',
        finalUrl: url,
      }));
    }).on('error', reject);
  });
}

function guessMimeFromUrl(url) {
  try {
    return guessMime(new URL(url).pathname);
  } catch (error) {
    return 'application/octet-stream';
  }
}

async function inlineRemoteAsset(url, assetCache) {
  if (!assetCache.has(url)) {
    const remote = await fetchRemoteBuffer(url);
    const mime = remote.contentType.split(';')[0] || guessMimeFromUrl(remote.finalUrl || url);
    assetCache.set(url, `data:${mime};base64,${remote.buffer.toString('base64')}`);
  }
  return assetCache.get(url);
}

async function inlineCssFile(cssPath, assetCache) {
  let css = fs.readFileSync(cssPath, 'utf-8');
  const cssDir = path.dirname(cssPath);
  css = await replaceAsync(css, /url\(([^)]+)\)/g, async (match, rawUrl) => {
    const url = rawUrl.replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:')) return match;
    if (/^https?:\/\//.test(url)) {
      try {
        const dataUrl = await inlineRemoteAsset(url, assetCache);
        return `url("${dataUrl}")`;
      } catch (error) {
        console.warn(`  WARN: failed to inline ${url}: ${error.message}`);
        return match;
      }
    }
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

async function buildSelfContainedHtml(deckPath, outputPath) {
  let html = fs.readFileSync(deckPath, 'utf-8');
  const baseDir = path.dirname(deckPath);
  const cssAssetCache = new Map();
  const inlineImages = new Map();
  const imageKeys = new Map();

  html = await replaceAsync(html, /<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>/g, async (match, href) => {
    const local = resolveLocalPath(href, baseDir);
    if (!local) return match;
    const css = await inlineCssFile(local, cssAssetCache);
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
    let key = imageKeys.get(local);
    if (!key) {
      key = `img_${imageKeys.size}`;
      imageKeys.set(local, key);
      const mime = guessMime(local);
      const data = fs.readFileSync(local).toString('base64');
      inlineImages.set(key, `data:${mime};base64,${data}`);
    }
    return match.replace(`src="${src}"`, `data-inline-image="${key}"`);
  });

  if (inlineImages.size > 0) {
    const loader = [
      '<script>',
      `const INLINE_IMAGES = ${JSON.stringify(Array.from(inlineImages).reduce((acc, [key, value]) => { acc[key] = value; return acc; }, {}))};`,
      "document.querySelectorAll('img[data-inline-image]').forEach((img) => {",
      "  const key = img.getAttribute('data-inline-image');",
      '  if (INLINE_IMAGES[key]) {',
      '    img.src = INLINE_IMAGES[key];',
      '  }',
      "  img.removeAttribute('data-inline-image');",
      '});',
      '</script>',
    ].join('\n');
    html = html.replace('</body>', `${loader}\n</body>`);
  }

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

async function buildDeck(deckName, formats) {
  const deckPath = path.join(DECKS_DIR, deckName, 'index.html');
  const distDir = path.join(DECKS_DIR, deckName, 'dist');

  for (const fmt of formats) {
    if (fmt === 'html') {
      await buildSelfContainedHtml(deckPath, path.join(distDir, 'slides.html'));
    } else if (fmt === 'pdf') {
      const htmlOut = path.join(distDir, 'slides.html');
      if (!fs.existsSync(htmlOut)) {
        await buildSelfContainedHtml(deckPath, htmlOut);
      }
      buildPdf(htmlOut, path.join(distDir, 'slides.pdf'));
    }
  }
}

async function main() {
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
    await buildDeck(target, formats);
  } else {
    const decks = findDecks();
    if (decks.length === 0) {
      console.log('No decks found in decks/');
      process.exit(0);
    }
    console.log(`Found ${decks.length} deck(s)`);
    for (const name of decks) {
      console.log(`\nBuilding deck: ${name}`);
      await buildDeck(name, formats);
    }
  }
  console.log('\nDone.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
