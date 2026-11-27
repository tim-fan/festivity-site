// Live session charts: battery (camera + tablet) and camera storage, last 2 hours.
// Plain SVG, no libraries (works offline). Dark surface only (the app is dark).

const WINDOW_MS = 2 * 3600 * 1000;
const C = {
  camera: '#3987e5', // categorical slot 1 (blue), dark-surface step
  tablet: '#d95926', // categorical slot 2 (orange), dark-surface step
  storage: '#3987e5',
  ink: '#eeeeee', ink2: '#aaaaaa', grid: '#333333', surface: '#1b1b1b',
};
const W = 600, H = 190, M = { l: 44, r: 64, t: 10, b: 26 };

// Least-squares slope (units per hour) of field over the last `spanMs` of samples.
export function slopePerHour(samples, field, spanMs = 30 * 60 * 1000) {
  const now = samples.length ? samples.at(-1).t : 0;
  const pts = samples.filter((s) => s[field] != null && now - s.t <= spanMs);
  if (pts.length < 5 || pts.at(-1).t - pts[0].t < 10 * 60 * 1000) return null; // need >= 10 min of data
  const xs = pts.map((p) => p.t / 3600e3), ys = pts.map((p) => p[field]);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return den ? num / den : null;
}

export const fmtHM = (h) => (h == null || !isFinite(h) ? '–' : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`);

// "≈ 3:20 left" from a level and a slope; null when not draining.
export function timeLeft(level, slope, floor = 5) {
  if (level == null || slope == null || slope > -0.5) return null;
  return Math.max(0, (level - floor) / -slope);
}

function lineChart(svgEl, { series, yMax, yLabel, yFmt, now }) {
  const x = (t) => M.l + ((t - (now - WINDOW_MS)) / WINDOW_MS) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - v / yMax) * (H - M.t - M.b);
  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const ticksX = [-120, -90, -60, -30, 0].map((m) => now + m * 60e3);
  let s = `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.surface}" rx="8"/>`;
  for (const v of ticksY) s += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/>` +
    `<text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${C.ink2}">${yFmt(v)}</text>`;
  for (const t of ticksX) {
    const m = Math.round((t - now) / 60e3);
    s += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${C.ink2}">${m === 0 ? 'now' : `${m} min`}</text>`;
  }
  for (const sr of series) {
    const pts = sr.points.filter((p) => p.t >= now - WINDOW_MS && p.v != null);
    if (!pts.length) continue;
    // break the line where samples are > 3 min apart (disconnected / app closed)
    let d = '', prev = null;
    for (const p of pts) { d += `${!prev || p.t - prev.t > 180e3 ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`; prev = p; }
    s += `<path d="${d}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts.at(-1);
    s += `<circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" fill="${sr.color}" stroke="${C.surface}" stroke-width="2"/>`;
    if (sr.label) s += `<text x="${x(last.t) + 8}" y="${y(last.v) + 4 + (sr.labelDy || 0)}" font-size="12" fill="${C.ink}">${sr.label}</text>`;
  }
  s += `<g class="hover" pointer-events="none"></g><rect class="hit" x="${M.l}" y="0" width="${W - M.l - M.r}" height="${H}" fill="transparent"/>`;
  svgEl.innerHTML = s;
  // hover/touch crosshair + readout
  const hit = svgEl.querySelector('.hit'), g = svgEl.querySelector('.hover');
  const show = (ev) => {
    const r = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = now - WINDOW_MS + ((px - M.l) / (W - M.l - M.r)) * WINDOW_MS;
    let txt = [], cx = null;
    for (const sr of series) {
      let best = null;
      for (const p of sr.points) if (p.v != null && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
      if (best && Math.abs(best.t - t) < 5 * 60e3) { txt.push(`${sr.name} ${yFmt(best.v, true)}`); cx = x(best.t); }
    }
    if (cx == null) { g.innerHTML = ''; return; }
    const when = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bx = Math.min(cx + 8, W - M.r - 150);
    g.innerHTML = `<line x1="${cx}" x2="${cx}" y1="${M.t}" y2="${H - M.b}" stroke="${C.ink2}" stroke-width="1"/>` +
      `<rect x="${bx}" y="${M.t + 4}" width="150" height="${18 + 16 * txt.length}" rx="6" fill="#000" stroke="${C.grid}"/>` +
      `<text x="${bx + 8}" y="${M.t + 19}" font-size="11" fill="${C.ink2}">${when}</text>` +
      txt.map((tx, i) => `<text x="${bx + 8}" y="${M.t + 35 + 16 * i}" font-size="12" fill="${C.ink}">${tx}</text>`).join('');
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => { g.innerHTML = ''; });
}

export function renderCharts(samples, nominalBytesPerSec) {
  const now = Date.now();
  const recent = samples.filter((s) => s.t >= now - WINDOW_MS);
  const last = (f) => { for (let i = recent.length - 1; i >= 0; i--) if (recent[i][f] != null) return recent[i]; return null; };

  // --- battery ---
  const cam = last('cam'), tab = last('tab');
  const camSlope = slopePerHour(recent, 'cam'), tabSlope = slopePerHour(recent, 'tab');
  const camLeft = timeLeft(cam?.cam, camSlope), tabLeft = tab?.tabCharging ? null : timeLeft(tab?.tab, tabSlope);
  const trend = (lvl, slope, left, charging) => lvl == null ? 'no data' :
    `${Math.round(lvl)}%` + (charging ? ' · charging' : slope == null ? ' · trend after 10 min' :
      left != null ? ` · ${slope.toFixed(1)}%/h · ≈ ${fmtHM(left)} left` : ` · steady (${slope >= 0 ? '+' : ''}${slope.toFixed(1)}%/h)`);
  document.getElementById('batt-summary').innerHTML =
    `<span style="color:${C.camera}">●</span> Camera ${trend(cam?.cam, camSlope, camLeft, false)}<br>` +
    `<span style="color:${C.tablet}">●</span> Tablet ${trend(tab?.tab, tabSlope, tabLeft, tab?.tabCharging)}`;
  // keep the two end labels apart when the lines end close together
  const camV = cam?.cam ?? 0, tabV = tab?.tab ?? 0, close = Math.abs(camV - tabV) < 9;
  lineChart(document.getElementById('chart-batt'), {
    now, yMax: 100, yLabel: 'Battery %', yFmt: (v) => `${Math.round(v)}%`,
    series: [
      { name: 'Camera', color: C.camera, points: recent.map((s) => ({ t: s.t, v: s.cam })), label: 'Camera', labelDy: close ? (camV >= tabV ? -7 : 7) : 0 },
      { name: 'Tablet', color: C.tablet, points: recent.map((s) => ({ t: s.t, v: s.tab })), label: 'Tablet', labelDy: close ? (tabV > camV ? -7 : 7) : 0 },
    ],
  });

  // --- storage, as hours of recording left ---
  const st = last('freeH');
  const drain = slopePerHour(recent, 'freeH'); // hours of storage lost per hour (≈ -1 while recording)
  document.getElementById('store-summary').innerHTML = st == null ? 'no data' :
    `<span style="color:${C.storage}">●</span> ≈ ${fmtHM(st.freeH)} of recording left (${(st.freeH * 3600 * nominalBytesPerSec / 1e9).toFixed(1)} GB)` +
    (drain != null && drain < -0.2 ? ` · full in ≈ ${fmtHM(st.freeH / -drain)}` : '') + (st.freeEst ? ' · estimated while recording' : '');
  const maxH = Math.max(1, Math.ceil(Math.max(...recent.map((s) => s.freeH ?? 0))));
  lineChart(document.getElementById('chart-store'), {
    now, yMax: maxH, yLabel: 'Recording time left (h)', yFmt: (v, full) => (full ? fmtHM(v) : `${v % 1 ? v.toFixed(1) : v} h`),
    series: [{ name: 'Left', color: C.storage, points: recent.map((s) => ({ t: s.t, v: s.freeH })) }],
  });
}
