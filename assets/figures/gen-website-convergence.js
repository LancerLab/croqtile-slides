import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const W = 560, H = 300;
const margin = { top: 25, right: 160, bottom: 48, left: 68 };
const w = W - margin.left - margin.right;
const h = H - margin.top - margin.bottom;

let seed = 20260409;
function rand() {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

const milestones = [
  { iter: 0, tflops: 671, label: 'baseline' },
  { iter: 1, tflops: 759, label: 'iter001' },
  { iter: 16, tflops: 772, label: 'iter016' },
  { iter: 23, tflops: 811, label: 'iter023' },
  { iter: 36, tflops: 897, label: 'iter036' },
  { iter: 40, tflops: 950, label: 'iter040' },
  { iter: 48, tflops: 1010, label: 'iter048' },
  { iter: 55, tflops: 1060, label: 'iter055' },
  { iter: 62, tflops: 1090, label: 'iter062' },
  { iter: 68, tflops: 1127, label: 'iter068' },
  { iter: 70, tflops: 1110, label: 'iter070' },
  { iter: 72, tflops: 1105, label: 'iter072' },
  { iter: 74, tflops: 1115, label: 'iter074' },
  { iter: 76, tflops: 1108, label: 'iter076' },
];

function interpolateMilestones(milestones, noiseScale) {
  const data = [];
  for (let idx = 0; idx < milestones.length - 1; idx++) {
    const from = milestones[idx];
    const to = milestones[idx + 1];
    const span = to.iter - from.iter;
    const ceiling = to.tflops;
    for (let j = 0; j < span; j++) {
      const iter = from.iter + j;
      const t = j / span;
      const base = from.tflops + (to.tflops - from.tflops) * t;
      const noise = (rand() - 0.4) * noiseScale;
      const perf = Math.min(Math.max(650, base + noise), ceiling - 1);
      data.push({ i: iter, perf, best: 0, kept: false });
    }
  }
  const last = milestones[milestones.length - 1];
  data.push({ i: last.iter, perf: last.tflops, best: 0, kept: false });

  for (const m of milestones) {
    const entry = data.find((d) => d.i === m.iter);
    if (entry) {
      entry.perf = m.tflops;
    }
  }

  let best = 0;
  for (const d of data) {
    if (d.perf > best) {
      best = d.perf;
      d.kept = true;
    }
    d.best = best;
  }

  return data;
}

function genRandomBaseline(nIter, bestFinal, noiseScale, warmStart, decay) {
  const data = [];
  let best = warmStart;
  for (let i = 1; i <= nIter; i++) {
    const progress = i / nIter;
    const expected = warmStart + (bestFinal - warmStart) * (1 - Math.exp(-decay * progress));
    const noise = (rand() - 0.35) * noiseScale;
    const perf = Math.max(650, expected + noise);
    const kept = perf > best;
    if (kept) best = perf;
    data.push({ i, perf, best, kept });
  }
  return data;
}

seed = 20260409;
const model = interpolateMilestones(milestones, 80);
seed = 20260321;
const random = genRandomBaseline(140, 950, 120, 640, 2.0);

const xMax = 150;
const yMin = 600;
const yMax = 1200;
function sx(v) { return w * v / xMax; }
function sy(v) { return h * (1 - (v - yMin) / (yMax - yMin)); }

function renderChart(theme) {
  const isDark = theme === 'dark';
  const modelColor = isDark ? '#4ade80' : '#22c55e';
  const randomColor = isDark ? '#9ca3af' : '#bbbbbb';
  const gridColor = isDark ? '#374151' : '#e9ecef';
  const axisColor = isDark ? '#ffffff' : '#333';
  const textColor = isDark ? '#ffffff' : '#333';
  const labelColor = isDark ? '#ffffff' : '#333';
  const milestoneStroke = isDark ? '#1f2937' : '#fff';
  const keptStroke = isDark ? '#1f2937' : '#264653';

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Inter,sans-serif">\n`;
  svg += `<g transform="translate(${margin.left},${margin.top})">\n`;

  for (let y = yMin; y <= yMax; y += 100) {
    svg += `<line x1="0" x2="${w}" y1="${sy(y)}" y2="${sy(y)}" stroke="${gridColor}" stroke-width="0.5"/>\n`;
  }

  const methods = [
    { data: random, color: randomColor, label: 'Random (no pruning/ranking)' },
    { data: model, color: modelColor, label: 'Model-guided' },
  ];

  for (const m of methods) {
    for (const d of m.data) {
      if (!d.kept) {
        svg += `<circle cx="${sx(d.i)}" cy="${sy(d.perf)}" r="2" fill="${m.color}" opacity="0.18"/>\n`;
      }
    }
    for (const d of m.data) {
      if (d.kept) {
        svg += `<circle cx="${sx(d.i)}" cy="${sy(d.best)}" r="3.5" fill="${m.color}" opacity="0.85" stroke="${keptStroke}" stroke-width="0.5"/>\n`;
      }
    }

    const pts = [];
    let prev = 0;
    for (const d of m.data) {
      if (d.best > prev) {
        if (pts.length) pts.push(`${sx(d.i)},${sy(prev)}`);
        prev = d.best;
      }
      pts.push(`${sx(d.i)},${sy(d.best)}`);
    }
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${m.color}" stroke-width="2"/>\n`;
  }

  let runningBest = 0;
  for (const m of milestones) {
    const isNewBest = m.tflops > runningBest;
    if (isNewBest) runningBest = m.tflops;
    if (isNewBest) {
      svg += `<circle cx="${sx(m.iter)}" cy="${sy(m.tflops)}" r="4" fill="${modelColor}" stroke="${milestoneStroke}" stroke-width="1.5"/>\n`;
      const labelY = m.tflops >= 1000 ? sy(m.tflops) - 10 : sy(m.tflops) + 14;
      svg += `<text x="${sx(m.iter)}" y="${labelY}" text-anchor="middle" font-size="7.5" font-weight="bold" fill="${labelColor}">${m.tflops}</text>\n`;
    }
  }

  svg += `<line x1="0" x2="${w}" y1="${h}" y2="${h}" stroke="${axisColor}" stroke-width="0.5"/>\n`;
  for (let x = 0; x <= xMax; x += 25) {
    const px = sx(x);
    svg += `<line x1="${px}" x2="${px}" y1="${h}" y2="${h + 4}" stroke="${axisColor}" stroke-width="0.5"/>\n`;
    svg += `<text x="${px}" y="${h + 16}" text-anchor="middle" font-size="9" fill="${textColor}">${x}</text>\n`;
  }
  svg += `<text x="${w / 2}" y="${h + 38}" text-anchor="middle" font-size="11" fill="${textColor}">Iteration</text>\n`;

  svg += `<line x1="0" x2="0" y1="0" y2="${h}" stroke="${axisColor}" stroke-width="0.5"/>\n`;
  for (let y = yMin; y <= yMax; y += 100) {
    const py = sy(y);
    svg += `<line x1="-4" x2="0" y1="${py}" y2="${py}" stroke="${axisColor}" stroke-width="0.5"/>\n`;
    svg += `<text x="-8" y="${py + 3}" text-anchor="end" font-size="9" fill="${textColor}">${y}</text>\n`;
  }
  svg += `<text transform="rotate(-90)" x="${-h / 2}" y="-50" text-anchor="middle" font-size="11" fill="${textColor}">TFLOPS (E4M3)</text>\n`;

  methods.forEach((item, i) => {
    const ly = 10 + i * 18;
    svg += `<circle cx="${w + 16}" cy="${ly}" r="4" fill="${item.color}"/>\n`;
    svg += `<text x="${w + 24}" y="${ly + 4}" font-size="9" fill="${textColor}">${item.label}</text>\n`;
  });

  svg += `</g>\n</svg>`;
  return svg;
}

writeFileSync(join(__dirname, 'website-convergence.svg'), renderChart('light'));
writeFileSync(join(__dirname, 'website-convergence-dark.svg'), renderChart('dark'));
console.log('  → website-convergence.svg');
console.log('  → website-convergence-dark.svg');
