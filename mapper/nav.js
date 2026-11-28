// Light Mapper: route picking, navigation, progress from the GPS log, demo mode, voice.
// Progress is never stored as "what was covered": it is recomputed from the recorder's GPS fixes
// (IndexedDB 'theta-recorder'/'fixes') since the route was pinned. Only the route copy, the run start
// time and the resume pointer are saved (IndexedDB 'light-mapper').
const $ = (id) => document.getElementById(id);
const MILE = 1609.34, BIN = 20, COVER_M = 20, RON = 25, ROFF = 35;
const VERSION = 'mapper-2026-11-28.1';
const Q = new URLSearchParams(location.search);

// ---------- storage ----------
function openDb(name, ver, upgrade) {
  return new Promise((res, rej) => { const r = indexedDB.open(name, ver); r.onupgradeneeded = () => upgrade(r.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
const mdb = openDb('light-mapper', 1, (db) => { db.createObjectStore('pins', { keyPath: 'id' }); db.createObjectStore('imported', { keyPath: 'id' }); db.createObjectStore('archive', { autoIncrement: true }); });
const rdb = openDb('theta-recorder', 1, (db) => { db.createObjectStore('fixes', { autoIncrement: true }); db.createObjectStore('events', { autoIncrement: true }); });
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function dbGet(dbp, store, key) { const db = await dbp; return req(db.transaction(store).objectStore(store).get(key)); }
async function dbAll(dbp, store) { const db = await dbp; return req(db.transaction(store).objectStore(store).getAll()); }
async function dbPut(dbp, store, v) { const db = await dbp; return req(db.transaction(store, 'readwrite').objectStore(store).put(v)); }
async function dbAdd(dbp, store, v) { const db = await dbp; return req(db.transaction(store, 'readwrite').objectStore(store).add(v)); }
async function dbDel(dbp, store, key) { const db = await dbp; return req(db.transaction(store, 'readwrite').objectStore(store).delete(key)); }
const fixesSince = async (t) => (await dbAll(rdb, 'fixes')).filter((f) => f.t >= t && f.lat != null).sort((a, b) => a.t - b.t);

// ---------- geometry ----------
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const brgXY = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
function proj(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
  const q = [a[0] + t * dx, a[1] + t * dy]; return { q, t, d: Math.hypot(p[0] - q[0], p[1] - q[1]) }; }

// A route prepared for navigation: metric coordinates, distance lookup, coverage bins, spatial grids.
class RouteModel {
  constructor(bundle) {
    this.bundle = bundle; const N = bundle.nav; this.R = N.route; this.M = N.maneuvers || []; this.H = N.houses || [];
    this.total = this.R[this.R.length - 1][2];
    const R = this.R; this.LAT0 = R[0][0]; this.LON0 = R[0][1]; this.KX = 111320 * Math.cos(this.LAT0 * Math.PI / 180); this.KY = 110540;
    this.RX = R.map((p) => this.xy(p[0], p[1]));
    this.nBins = Math.ceil(this.total / BIN) + 1;
    // grid over route segments (for coverage marking)
    this.RG = new Map(); const C = 50;
    for (let i = 1; i < R.length; i++) this.gridAdd(this.RG, C, this.RX[i - 1], this.RX[i], i);
    // street network (for snapping when off the route)
    this.SEG = []; this.NG = new Map();
    for (const e of (bundle.net?.net || [])) { const c = e.c.map((p) => this.xy(p[0], p[1]));
      for (let i = 1; i < c.length; i++) { const id = this.SEG.length; this.SEG.push({ a: c[i - 1], b: c[i], name: e.n, oneway: e.o }); this.gridAdd(this.NG, 60, c[i - 1], c[i], id); } }
  }
  xy(lat, lon) { return [(lon - this.LON0) * this.KX, (lat - this.LAT0) * this.KY]; }
  ll(x, y) { return [this.LAT0 + y / this.KY, this.LON0 + x / this.KX]; }
  gridAdd(G, C, a, b, id) { for (let gx = Math.floor(Math.min(a[0], b[0]) / C); gx <= Math.floor(Math.max(a[0], b[0]) / C); gx++)
    for (let gy = Math.floor(Math.min(a[1], b[1]) / C); gy <= Math.floor(Math.max(a[1], b[1]) / C); gy++) { const k = gx + ',' + gy; if (!G.has(k)) G.set(k, []); G.get(k).push(id); } }
  near(G, C, p) { const out = new Set(), gx = Math.floor(p[0] / C), gy = Math.floor(p[1] / C);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const id of (G.get((gx + i) + ',' + (gy + j)) || [])) out.add(id); return out; }
  idxAt(d) { const R = this.R; let lo = 0, hi = R.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (R[m][2] < d) lo = m + 1; else hi = m; } return lo; }
  pt(d) { const R = this.R, i = Math.max(1, this.idxAt(d)), a = this.RX[i - 1], b = this.RX[i], f = Math.max(0, Math.min(1, (d - R[i - 1][2]) / Math.max(1e-6, R[i][2] - R[i - 1][2])));
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
  brg(d) { const i = Math.max(1, this.idxAt(d)); return brgXY(this.RX[i - 1], this.RX[i]); }
  // mark the coverage bins of every route stretch within COVER_M of p (either direction: the camera films both sides)
  // prev = the route distances matched by the previous fix; stretches between consecutive fixes (<= 80 m apart along the route) are filled in
  cover(bins, p, prev) { let hit = false; const ds = [];
    for (const i of this.near(this.RG, 50, p)) { const r = proj(p, this.RX[i - 1], this.RX[i]);
      if (r.d < COVER_M) { const d = this.R[i - 1][2] + r.t * (this.R[i][2] - this.R[i - 1][2]); ds.push(d);
        let from = Math.floor(d / BIN); if (prev) for (const pd of prev) if (d - pd > 0 && d - pd <= 80) from = Math.min(from, Math.floor(pd / BIN));
        for (let b = from; b <= Math.floor(d / BIN); b++) if (!bins[b]) { bins[b] = 1; hit = true; } } }
    if (prev) { prev.length = 0; prev.push(...ds); }
    return hit; }
  snapNet(p, prior) { let best = null;
    for (const id of this.near(this.NG, 60, p)) { const s = this.SEG[id], r = proj(p, s.a, s.b); if (r.d > 30) continue;
      let b = brgXY(s.a, s.b); if (prior != null && angDiff(b, prior) > 90 && !s.oneway) b = (b + 180) % 360;
      const score = r.d + (prior != null ? angDiff(b, prior) / 6 : 0); if (!best || score < best.score) best = { q: r.q, brg: b, name: s.name, score }; }
    return best; }
  sliceLL(a, b) { if (b <= a) return []; const R = this.R, i = this.idxAt(a), j = this.idxAt(b), out = [];
    const pa = this.ll(...this.pt(a)); out.push([pa[1], pa[0]]); for (let k = i; k < j; k++) out.push([R[k][1], R[k][0]]); const pb = this.ll(...this.pt(b)); out.push([pb[1], pb[0]]); return out; }
  streetAt(d) { for (let i = this.M.length - 1; i >= 0; i--) if (this.M[i].d <= d) return this.M[i].street; return ''; }
  amberEnd(here) { const M = this.M; let end = Math.min(this.total, here + MILE), turns = 0;
    for (const m of M) { if (m.d <= here + 3) continue; if (m.d >= end) break;
      if (m.type === 'uturn') { end = m.d; break; } if (m.type === 'left' || m.type === 'right') { if (++turns === 2) { end = m.d; break; } } }
    const i0 = this.idxAt(here), i1 = this.idxAt(end);
    for (let j = i0 + 1; j <= i1; j++) for (let i = i0; i < j; i++) { if (this.R[j][2] - this.R[i][2] < 60) break; if (Math.hypot(this.RX[i][0] - this.RX[j][0], this.RX[i][1] - this.RX[j][1]) < 12) return this.R[j - 1][2]; }
    return end; }
}

// Strict-sequence snapper: progress only moves forward along the route, within a short window.
class Snapper {
  constructor(model, s = 0) { this.m = model; this.s = s; this.mode = 'on'; this.offCnt = 0; this.hist = []; this.motion = null; this.snapped = null; this.heading = 0; this.road = ''; }
  fix(lat, lon, gpsHeading, speed) {
    const m = this.m, p = m.xy(lat, lon);
    this.hist.push(p); if (this.hist.length > 4) this.hist.shift();
    if (this.hist.length >= 3 && Math.hypot(p[0] - this.hist[0][0], p[1] - this.hist[0][1]) > 8) this.motion = brgXY(this.hist[0], p);
    else if (this.motion == null && speed > 2 && gpsHeading != null) this.motion = gpsHeading;
    const lo = this.s - 25, hi = this.s + (this.mode === 'on' ? Math.max(80, (speed || 0) * 4 + 40) : 80);
    let cand = null, minD = 1e9;
    for (let i = Math.max(1, m.idxAt(lo)); i < m.R.length && m.R[i - 1][2] <= hi; i++) {
      const r = proj(p, m.RX[i - 1], m.RX[i]); minD = Math.min(minD, r.d);
      const sp = m.R[i - 1][2] + r.t * (m.R[i][2] - m.R[i - 1][2]), b = brgXY(m.RX[i - 1], m.RX[i]);
      if (r.d < RON && (this.motion == null || angDiff(b, this.motion) < 75) && sp >= lo) { cand = { sp, q: r.q, b }; break; }
    }
    if (cand) { this.mode = 'on'; this.offCnt = 0; this.s = Math.max(this.s, cand.sp); this.snapped = cand.q; this.heading = cand.b; this.road = ''; }
    else {
      if (minD > ROFF) this.offCnt++; if (this.offCnt >= 3) this.mode = 'off';
      const n = m.snapNet(p, this.motion);
      if (n) { this.snapped = n.q; this.heading = n.brg; this.road = n.name || 'unnamed road'; } else { this.snapped = p; if (this.motion != null) this.heading = this.motion; this.road = 'no road'; }
    }
    return p;
  }
}

// ---------- route catalogue ----------
let catalogue = [];
async function loadCatalogue() {
  let hosted = [];
  try { hosted = await (await fetch('routes/index.json', { cache: 'no-cache' })).json(); } catch (e) { console.warn('route list', e); }
  const imported = (await dbAll(mdb, 'imported')).map((r) => ({ id: r.id, name: r.name, desc: r.desc || 'added from file', version: r.version, local: true }));
  catalogue = [...hosted, ...imported];
}
async function fetchBundle(entry) {
  if (entry.local) return (await dbGet(mdb, 'imported', entry.id)).bundle;
  return await (await fetch('routes/' + entry.bundle)).json();
}
async function routeCoverage(pin) {
  const model = new RouteModel(pin.bundle), bins = new Uint8Array(model.nBins);
  const prev = []; for (const f of await fixesSince(pin.runStart)) model.cover(bins, model.xy(f.lat, f.lon), prev);
  return { model, bins, pct: bins.reduce((a, b) => a + b, 0) / model.nBins };
}
function miniMap(bundle, bins) {
  const R = bundle.nav.route, lat0 = R[0][0], kx = Math.cos(lat0 * Math.PI / 180);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of R) { const x = p[1] * kx, y = -p[0]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const W = 300, H = 150, pad = 8, sc = Math.min((W - 2 * pad) / (x1 - x0 || 1e-9), (H - 2 * pad) / (y1 - y0 || 1e-9));
  const X = (p) => (pad + (p[1] * kx - x0) * sc + (W - 2 * pad - (x1 - x0) * sc) / 2).toFixed(1), Y = (p) => (pad + (-p[0] - y0) * sc + (H - 2 * pad - (y1 - y0) * sc) / 2).toFixed(1);
  const step = Math.max(1, Math.floor(R.length / 900)); let grey = '', green = '';
  for (let i = step; i < R.length; i += step) { const a = R[i - step], b = R[i], seg = `M${X(a)} ${Y(a)}L${X(b)} ${Y(b)}`; if (bins && bins[Math.floor(b[2] / BIN)]) green += seg; else grey += seg; }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><path d="${grey}" stroke="#8a8f98" stroke-width="1.6" fill="none"/><path d="${green}" stroke="#2f9e44" stroke-width="2" fill="none"/></svg>`;
}
async function renderHome() {
  await loadCatalogue();
  const el = $('cards'); el.innerHTML = '';
  for (const entry of catalogue) {
    const pin = await dbGet(mdb, 'pins', entry.id);
    const card = document.createElement('div'); card.className = 'rcard';
    let svg = '<svg viewBox="0 0 300 150"></svg>', pctTxt = 'Not started', pct = 0, meta = entry.desc || '';
    if (pin) { const c = await routeCoverage(pin); pct = c.pct; svg = miniMap(pin.bundle, c.bins); pctTxt = `${Math.round(pct * 100)}% covered · started ${new Date(pin.runStart).toLocaleDateString()}`; }
    else { try { const b = await fetchBundle(entry); svg = miniMap(b, null); } catch { /* offline */ } }
    card.innerHTML = `${svg}<div class="body"><div class="name">${entry.name}${entry.local ? '<span class="tag">local</span>' : ''}</div><div class="meta">${meta}</div>
      <div class="prog"><div style="width:${(pct * 100).toFixed(1)}%"></div></div><div class="pct">${pctTxt}</div>${localStorage.getItem(offlineKey(entry.id)) ? '<div class="off">✓ Map saved for offline</div>' : ''}${pin && pin.version !== entry.version ? '<div class="newer">Newer route available (reset progress to use it)</div>' : ''}</div>`;
    card.onclick = () => openRoute(entry);
    el.appendChild(card);
  }
  if (!catalogue.length) el.innerHTML = '<div class="sub">No routes yet. Add one from a file.</div>';
  for (const entry of catalogue) if (!localStorage.getItem(offlineKey(entry.id))) fetchBundle(entry).then((b) => cacheRouteOffline(b, entry.id, false)).catch(() => {});
}

// ---------- offline map: style (with a plain fallback) + all tiles/fonts/icons around a route ----------
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty', RUNTIME_CACHE = 'light-mapper-runtime';
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ece8e0' } }] };
async function loadStyle() {
  try { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000); const r = await fetch(STYLE_URL, { signal: ctl.signal }); clearTimeout(t); if (!r.ok) throw new Error(r.status); return await r.json(); }
  catch (e) { console.warn('map style unavailable, using plain background', e); return FALLBACK_STYLE; }
}
const offlineKey = (id) => 'mapper-offline-' + id;
const offlineBusy = new Set();
async function cacheRouteOffline(bundle, id, show) {
  if (!navigator.onLine || offlineBusy.has(id) || !('caches' in window)) return; offlineBusy.add(id);
  const el = $('offline'), say = (t) => { if (show) { el.hidden = !t; el.textContent = t; } };
  try {
    const st = await (await fetch(STYLE_URL)).json(), urls = new Set([STYLE_URL]);
    if (typeof st.sprite === 'string') for (const sfx of ['.json', '.png', '@2x.json', '@2x.png']) urls.add(st.sprite + sfx);
    const fonts = new Set(); for (const l of st.layers) { const f = l.layout?.['text-font']; if (Array.isArray(f) && f.every((x) => typeof x === 'string')) fonts.add(f.join(',')); }
    for (const f of fonts) for (const rg of ['0-255', '256-511', '8192-8447']) urls.add(st.glyphs.replace('{fontstack}', f).replace('{range}', rg));
    // bounding box of the route + 2 km for detours
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180; for (const p of bundle.nav.route) { la0 = Math.min(la0, p[0]); la1 = Math.max(la1, p[0]); lo0 = Math.min(lo0, p[1]); lo1 = Math.max(lo1, p[1]); }
    const padLa = 2000 / 110540, padLo = 2000 / (111320 * Math.cos(la0 * Math.PI / 180)); la0 -= padLa; la1 += padLa; lo0 -= padLo; lo1 += padLo;
    const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), ty = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    for (const src of Object.values(st.sources)) {
      if (src.type !== 'vector') continue; let tj = src; if (src.url) { urls.add(src.url); tj = await (await fetch(src.url)).json(); }
      const tmpl = tj.tiles[0], maxz = Math.min(14, tj.maxzoom ?? 14);
      for (let z = 8; z <= maxz; z++) for (let x = tx(lo0, z); x <= tx(lo1, z); x++) for (let y = ty(la1, z); y <= ty(la0, z); y++) urls.add(tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    const cache = await caches.open(RUNTIME_CACHE), list = [...urls]; let done = 0, failed = 0;
    for (let i = 0; i < list.length; i += 6) {
      await Promise.all(list.slice(i, i + 6).map(async (u) => { try { if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); else failed++; } } catch { failed++; } done++; }));
      say(`Offline map: ${done}/${list.length}`);
    }
    if (failed < list.length * 0.05) { localStorage.setItem(offlineKey(id), String(Date.now())); say('✓ Offline map ready'); setTimeout(() => say(''), 4000); }
    else say(`Offline map incomplete (${failed} failed)`);
  } catch (e) { say('Offline map: no connection'); setTimeout(() => say(''), 4000); }
  finally { offlineBusy.delete(id); }
}

// ---------- modal ----------
function modal(title, body, buttons) {
  return new Promise((res) => { $('m-title').textContent = title; $('m-body').textContent = body; const b = $('m-btns'); b.innerHTML = '';
    buttons.forEach(([label, cls, val]) => { const x = document.createElement('button'); x.textContent = label; x.className = cls; x.onclick = () => { $('modal').hidden = true; res(val); }; b.appendChild(x); });
    $('modal').hidden = false; });
}

// ---------- voice ----------
const voice = {
  on: localStorage.getItem('mapper-voice') !== '0', said: new Set(),
  set(v) { this.on = v; localStorage.setItem('mapper-voice', v ? '1' : '0'); $('b-voice').textContent = v ? '🔊' : '🔇'; if (!v) speechSynthesis?.cancel(); },
  say(text, urgent) { if (!this.on || !window.speechSynthesis) return; if (urgent) speechSynthesis.cancel(); else if (speechSynthesis.speaking) return;
    const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 1.0; speechSynthesis.speak(u); },
};
const speakDist = (m) => m < 300 ? `${Math.max(50, Math.round(m * 3.281 / 50) * 50)} feet` : m < 0.3 * MILE ? 'a quarter mile' : `${(m / MILE).toFixed(1)} miles`;

// ---------- mapping screen ----------
let S = null;   // current session state
let map = null, car = null, ghost = null, mapReady = false;
const fmt = (m) => m < 300 ? `${Math.round(m * 3.281 / 10) * 10} ft` : `${(m / MILE).toFixed(1)} mi`;

async function openRoute(entry) {
  const demo = $('demo-toggle').checked;
  let pin = await dbGet(mdb, 'pins', entry.id), bundle;
  if (pin) bundle = pin.bundle;
  else {
    try { bundle = await fetchBundle(entry); } catch (e) { await modal('Route unavailable', 'Could not load this route (offline?). ' + e.message, [['OK', 'sec']]); return; }
    if (!demo) { pin = { id: entry.id, name: entry.name, version: entry.version, bundle, runStart: Date.now(), ptr: 0, ptrAt: 0 }; await dbPut(mdb, 'pins', pin); }
  }
  const model = new RouteModel(bundle);
  const bins = new Uint8Array(model.nBins);
  let s0 = 0;
  if (!demo && pin) {
    // rebuild progress from the GPS log: coverage + where the last session ended
    const fixes = await fixesSince(pin.runStart), snap = new Snapper(model);
    const prev = []; for (const f of fixes) { const p = snap.fix(f.lat, f.lon, f.hdg, f.spd); model.cover(bins, p, prev); }
    const lastFixT = fixes.length ? fixes[fixes.length - 1].t : 0;
    s0 = pin.ptrAt > lastFixT ? pin.ptr : snap.s;
  }
  S = { entry, pin, demo, model, bins, snap: new Snapper(model, s0), skippedNote: false, lastSave: 0, scrubT: null, zoomMode: 'all', following: true,
        view: null, lastDrawn: -1, dirty: true, speedup: 12, sim: null, offAnnounced: false, prevCov: [] };
  $('home').hidden = true; $('mapscr').hidden = false; $('demobar').hidden = !demo; document.body.classList.add('onmap');
  voice.set(voice.on); voice.said.clear();
  await setupMap();
  cacheRouteOffline(bundle, entry.id, true);
  if (demo) startSim(); else window.addEventListener('gpsfix', onGpsFix);
  const p = model.ll(...model.pt(s0)); S.snap.snapped = model.pt(s0); S.snap.heading = model.brg(s0);
  S.view = { lng: p[1], lat: p[0], brg: S.snap.heading };
  if (mapReady) { map.jumpTo({ center: [p[1], p[0]], bearing: S.snap.heading }); redraw(true); }
  if (!demo && s0 > 0) voice.say(`Resuming at ${(s0 / MILE).toFixed(1)} miles. ${model.streetAt(s0) || ''}`);
}
function closeRoute() {
  window.removeEventListener('gpsfix', onGpsFix);
  if (S?.sim) S.sim.stop = true;
  speechSynthesis?.cancel(); S = null;
  $('mapscr').hidden = true; $('home').hidden = false; document.body.classList.remove('onmap'); camTab(false); renderHome();
}
function onGpsFix(e) { const f = e.detail; if (!S || S.demo) return; step(f.lat, f.lon, f.hdg, f.spd); }
function step(lat, lon, hdg, spd) {
  const before = S.snap.mode, p = S.snap.fix(lat, lon, hdg, spd);
  if (S.model.cover(S.bins, p, S.prevCov)) S.dirty = true;
  if (before !== S.snap.mode) { S.dirty = true; if (S.snap.mode === 'off') voice.say('Off route. Head back to the route.', true); else voice.say('Back on route.', true); }
  announce(spd);
  if (!S.demo && S.pin && Date.now() - S.lastSave > 5000) { S.lastSave = Date.now(); S.pin.ptr = S.snap.s; S.pin.ptrAt = Date.now(); dbPut(mdb, 'pins', S.pin); }
  redraw();
}
function announce(spd) {
  if (S.snap.mode !== 'on' || S.scrubT != null) return;
  const M = S.model.M, s = S.snap.s; const mi = M.findIndex((m) => m.d > s - 3); if (mi < 0) return;
  const m = M[mi], d = m.d - s, fast = (spd || 0) * (S.demo ? S.speedup : 1);
  if (d < 45 && !voice.said.has(mi + 'n')) { voice.said.add(mi + 'n'); voice.said.add(mi + 'f'); voice.say(m.text, true); }
  else if (d > 90 && d < 260 && !voice.said.has(mi + 'f') && fast < 40) { voice.said.add(mi + 'f'); voice.say(`In ${speakDist(d)}, ${m.text}`); }
}

async function setupMap() {
  if (map) { map.resize(); return; }
  const style = await loadStyle();
  map = new maplibregl.Map({ container: 'map', style, center: [-117.16, 32.75], zoom: 17, pitch: 58, attributionControl: { compact: true } });
  const carEl = document.createElement('div'); carEl.className = 'car';
  carEl.innerHTML = '<svg viewBox="0 0 34 34" width="48" height="48"><circle cx="17" cy="17" r="15" fill="#1971c2" stroke="#fff" stroke-width="3"/><path d="M17 7l7 16-7-4-7 4z" fill="#fff"/></svg>';
  car = new maplibregl.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([-117.16, 32.75]).addTo(map);
  const gEl = document.createElement('div'); gEl.innerHTML = '<svg viewBox="0 0 30 30" width="30" height="30"><circle cx="15" cy="15" r="12" fill="#fff" fill-opacity=".85" stroke="#37474f" stroke-width="3" stroke-dasharray="4 3"/></svg>';
  ghost = new maplibregl.Marker({ element: gEl });
  map.on('load', () => {
    const fc = () => ({ type: 'FeatureCollection', features: [] });
    const addLine = (id, paint) => { map.addSource(id, { type: 'geojson', data: fc() }); map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint }); };
    addLine('skipped', { 'line-color': '#e03131', 'line-width': 7, 'line-opacity': .9 });
    addLine('todo', { 'line-color': '#8a8f98', 'line-width': 6, 'line-opacity': .8 });
    addLine('done', { 'line-color': '#40c057', 'line-width': 7, 'line-opacity': .9 });
    addLine('amber', { 'line-color': '#ffb300', 'line-width': 16 });
    const cv = document.createElement('canvas'); cv.width = cv.height = 32; const g = cv.getContext('2d');
    g.strokeStyle = '#6b3f00'; g.lineWidth = 5; g.lineCap = g.lineJoin = 'round'; g.beginPath(); g.moveTo(8, 22); g.lineTo(16, 10); g.lineTo(24, 22); g.stroke();
    map.addImage('chev', { width: 32, height: 32, data: g.getImageData(0, 0, 32, 32).data });
    map.addSource('marks', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'dots', type: 'circle', source: 'marks', filter: ['==', ['get', 'k'], 'dot'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-pitch-alignment': 'map' } });
    map.addLayer({ id: 'chev', type: 'symbol', source: 'marks', filter: ['==', ['get', 'k'], 'chev'], layout: { 'icon-image': 'chev', 'icon-size': .55, 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true } });
    mapReady = true; if (S) { redraw(true); } requestAnimationFrame(camera);
  });
  // touching the map stops following (caught before the follow camera can interrupt the gesture)
  ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach((ev) => map.on(ev, (e) => { if (e.originalEvent) setFollow(false); }));
  const cc = map.getCanvasContainer(); let down = null;
  cc.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; }, true);
  cc.addEventListener('pointermove', (e) => { if (down && S?.following && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) setFollow(false); }, true);
  ['pointerup', 'pointercancel'].forEach((ev) => cc.addEventListener(ev, () => { down = null; }, true));
  cc.addEventListener('touchstart', (e) => { if (e.touches.length >= 2) setFollow(false); }, { capture: true, passive: true });
  cc.addEventListener('wheel', () => setFollow(false), { capture: true, passive: true });
}
function setFollow(on) { if (!S) return; S.following = on; $('recenter').hidden = on;
  if (on) { const q = S.scrubT != null ? S.model.ll(...S.model.pt(S.scrubT)) : S.model.ll(...S.snap.snapped); S.view = { lng: q[1], lat: q[0], brg: S.scrubT != null ? S.model.brg(S.scrubT) : S.snap.heading }; } }
function camera() {
  if (S && S.following && S.snap.snapped && mapReady) {
    const m = S.model, q = S.scrubT != null ? m.ll(...m.pt(S.scrubT)) : m.ll(...S.snap.snapped), hd = S.scrubT != null ? m.brg(S.scrubT) : S.snap.heading, a = .15, v = S.view;
    v.lng += (q[1] - v.lng) * a; v.lat += (q[0] - v.lat) * a; const db = ((hd - v.brg + 540) % 360) - 180; v.brg = (v.brg + db * .08 + 360) % 360;
    const topY = $('turn').getBoundingClientRect().bottom + 8, botY = $('bottom').getBoundingClientRect().top - 8, avail = Math.max(60, botY - topY);
    map.jumpTo({ center: [v.lng, v.lat], bearing: v.brg, pitch: 58, zoom: innerHeight < 520 ? 17.6 : 18.3, padding: { top: topY + avail * .45, bottom: innerHeight - botY, left: 0, right: 0 } });
  }
  requestAnimationFrame(camera);
}
// coverage runs: covered (green), uncovered before the pointer (red: skipped), uncovered after (grey: to do)
function runs(bins, s) { const out = { done: [], skipped: [], todo: [] }; let cur = null, a = 0;
  const cls = (b) => bins[b] ? 'done' : (b * BIN + BIN <= s ? 'skipped' : 'todo');
  for (let b = 0; b < bins.length; b++) { const c = cls(b); if (c !== cur) { if (cur) out[cur].push([a, b * BIN]); cur = c; a = b * BIN; } }
  if (cur) out[cur].push([a, bins.length * BIN]); return out; }
function redraw(force) {
  if (!S || !mapReady) return; const m = S.model, s = S.snap.s;
  if (S.snap.snapped) { const q = m.ll(...S.snap.snapped); car.setLngLat([q[1], q[0]]); car.setRotation(S.snap.heading); }
  if (!force && !S.dirty && Math.abs(s - S.lastDrawn) < 3) { banner(); return; }
  S.lastDrawn = s; S.dirty = false;
  const end = m.amberEnd(s), R = runs(S.bins, s), feats = (iv) => ({ type: 'FeatureCollection', features: iv.filter(([a, b]) => b > a).map(([a, b]) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: m.sliceLL(a, Math.min(b, m.total)) } })) });
  map.getSource('done').setData(feats(R.done)); map.getSource('skipped').setData(feats(R.skipped)); map.getSource('todo').setData(feats(R.todo)); map.getSource('amber').setData(feats([[s, end]]));
  const f = []; let n = 0;
  for (let d = Math.ceil(s / 20) * 20 + 20; d < end; d += 20, n++) { const q = m.ll(...m.pt(d)); f.push({ type: 'Feature', properties: n % 3 === 1 ? { k: 'chev', b: m.brg(d) } : { k: 'dot' }, geometry: { type: 'Point', coordinates: [q[1], q[0]] } }); }
  map.getSource('marks').setData({ type: 'FeatureCollection', features: f });
  const covered = S.bins.reduce((a, b) => a + b, 0) / m.nBins, skippedLen = R.skipped.reduce((t, [a, b]) => t + b - a, 0);
  $('pct').textContent = (100 * covered).toFixed(1) + '%';
  $('pctsub').textContent = `covered${skippedLen > 0.05 * MILE ? ` · ${(skippedLen / MILE).toFixed(1)} mi skipped` : ''}${S.demo ? ' (demo)' : ''}`;
  const hc = m.H.filter((h) => h[2] >= 0 && S.bins[Math.floor(h[2] / BIN)]).length;
  $('houses').textContent = m.H.length ? hc.toLocaleString() : '–'; $('housesub').textContent = m.H.length ? `houses of ${m.H.length.toLocaleString()}` : 'houses (n/a)';
  $('left').textContent = (R.todo.concat(R.skipped).reduce((t, [a, b]) => t + b - a, 0) / MILE).toFixed(1);
  banner(); drawBar();
}
function setArrow(t) { const p = { straight: 'M32 56V14M18 28l14-14 14 14', right: 'M20 56V34q0-10 10-10h20M40 14l10 10-10 10', left: 'M44 56V34q0-10-10-10H14M24 14 14 24l10 10',
  uturn: 'M22 56V26a10 10 0 0 1 20 0v20M32 38l10 10 10-10', back: 'M32 10a22 22 0 1 0 0.1 0M32 20v14l9 6', eye: 'M6 32q26-26 52 0q-26 26-52 0zM32 25a7 7 0 1 0 .1 0', flag: 'M18 58V8M18 10h28l-6 9 6 9H18' }[t] || '';
  $('arrow').innerHTML = `<path d="${p}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`; }
function banner() {
  const T = $('turn'), m = S.model, s = S.snap.s; T.className = ''; $('b-gmaps').hidden = !(S.snap.mode === 'off' && S.scrubT == null);
  $('mode').textContent = S.snap.mode === 'on' ? 'route' : 'off route'; $('modesub').textContent = S.snap.mode === 'on' ? 'snapped to planned route' : `snapped to ${S.snap.road}`;
  if (S.scrubT != null) { T.className = 'preview'; setArrow('eye'); const dd = S.scrubT - s; $('dist').textContent = (dd >= 0 ? '+' : '−') + fmt(Math.abs(dd));
    $('txt').textContent = 'Preview: ' + (m.streetAt(S.scrubT) || 'route'); $('then').textContent = dd >= 0 ? 'Skip to here jumps ahead (anything undriven shows red)' : 'Back to here lets you redo from this point'; return; }
  if (S.snap.mode === 'off') { T.className = 'off'; setArrow('back'); const t = m.pt(s), d = S.snap.snapped ? Math.hypot(S.snap.snapped[0] - t[0], S.snap.snapped[1] - t[1]) : 0;
    $('dist').textContent = fmt(d); $('txt').textContent = `Off route (on ${S.snap.road}). Head back to the route`; $('then').textContent = 'Can’t get back? Use the timeline to skip ahead.'; return; }
  const M = m.M; let mi = M.findIndex((x) => x.d > s - 5);
  if (mi < 0) { setArrow('flag'); $('dist').textContent = fmt(Math.max(0, m.total - s)); $('txt').textContent = 'End of route'; $('then').textContent = ''; return; }
  const x = M[mi], n = M[mi + 1]; setArrow(x.type); $('dist').textContent = fmt(Math.max(0, x.d - s)); $('txt').textContent = x.text; $('then').textContent = n ? `Then: ${n.text}` : '';
}

// ---------- timeline ----------
const bar = $('bar'), bctx = bar.getContext('2d');
function win() { const m = S.model; if (S.zoomMode === 'all') return [0, m.total]; const w = +S.zoomMode * MILE, c = S.scrubT != null ? S.scrubT : S.snap.s;
  let a = Math.max(0, c - w / 2), b = Math.min(m.total, a + w); a = Math.max(0, b - w); return [a, b]; }
function drawBar() {
  if (!S) return; const W = bar.clientWidth, Hh = bar.clientHeight; if (!W) return; if (bar.width !== W * 2) { bar.width = W * 2; bar.height = Hh * 2; }
  const g = bctx, m = S.model, s = S.snap.s; g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, W, Hh);
  const [a, b] = win(), X = (d) => (d - a) / (b - a) * W, R = runs(S.bins, s);
  g.fillStyle = '#4a4f57'; g.fillRect(0, 14, W, 16);
  g.fillStyle = '#e03131'; R.skipped.forEach(([u, v]) => g.fillRect(X(u), 14, Math.max(1, X(v) - X(u)), 16));
  g.fillStyle = '#40c057'; R.done.forEach(([u, v]) => g.fillRect(X(u), 14, Math.max(1, X(v) - X(u)), 16));
  g.fillStyle = '#ffb300'; g.fillRect(X(s), 14, Math.max(2, X(m.amberEnd(s)) - X(s)), 6);
  g.fillStyle = '#ccc'; g.font = '10px system-ui'; const span = b - a;
  const st = span > 20 * MILE ? 10 * MILE : span > 3 * MILE ? MILE : span > .6 * MILE ? .25 * MILE : .05 * MILE;
  for (let d = Math.ceil(a / st) * st; d <= b; d += st) { g.fillRect(X(d), 30, 1, 5); g.fillText(`${(d / MILE).toFixed(st < MILE ? 2 : 0)} mi`, X(d) + 2, 43); }
  if (span < 1.2 * MILE) { g.fillStyle = '#fff'; m.M.forEach((x) => { if (x.d >= a && x.d <= b && x.type !== 'straight') g.fillRect(X(x.d) - .5, 10, 1, 4); }); }
  g.fillStyle = '#1971c2'; g.beginPath(); g.arc(X(s), 22, 7, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  if (S.zoomMode !== 'all') { g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(W / 2 - .5, 4, 1, 30); }
  if (S.scrubT != null) { g.fillStyle = '#fff'; g.fillRect(X(S.scrubT) - 1.5, 4, 3, 30); g.beginPath(); g.moveTo(X(S.scrubT) - 6, 2); g.lineTo(X(S.scrubT) + 6, 2); g.lineTo(X(S.scrubT), 9); g.fill(); }
}
function scrubTo(t) { const m = S.model; S.scrubT = Math.max(0, Math.min(m.total, t)); const q = m.ll(...m.pt(S.scrubT)); ghost.setLngLat([q[1], q[0]]).addTo(map);
  $('skip').classList.toggle('hid', !(S.scrubT > S.snap.s + 5)); $('back').classList.toggle('hid', !(S.scrubT < S.snap.s - 5)); $('resume').classList.remove('hid');
  $('tlinfo').textContent = `${(S.scrubT / MILE).toFixed(2)} mi · ${m.streetAt(S.scrubT) || ''}`; banner(); drawBar(); }
function endScrub() { if (!S) return; S.scrubT = null; ghost.remove(); ['skip', 'back', 'resume'].forEach((id) => $(id).classList.add('hid')); $('tlinfo').textContent = 'drag to preview'; S.dirty = true; redraw(true); }
function jumpTo(t) { const sn = S.snap; sn.s = t; sn.mode = 'on'; sn.offCnt = 0; sn.snapped = S.model.pt(t); sn.heading = S.model.brg(t); voice.said.clear();
  if (S.pin && !S.demo) { S.pin.ptr = t; S.pin.ptrAt = Date.now(); dbPut(mdb, 'pins', S.pin); } if (S.sim) S.sim.s = t; endScrub(); }
let dragging = false, lastX = 0;
bar.addEventListener('pointerdown', (e) => { if (!S) return; dragging = true; bar.setPointerCapture(e.pointerId); lastX = e.clientX;
  const r = bar.getBoundingClientRect(), [a, b] = win(); if (S.zoomMode === 'all') scrubTo(a + (e.clientX - r.left) / r.width * (b - a)); else if (S.scrubT == null) scrubTo(S.snap.s); });
bar.addEventListener('pointermove', (e) => { if (!dragging || !S) return; const r = bar.getBoundingClientRect(), [a, b] = win();
  if (S.zoomMode === 'all') { scrubTo(a + (e.clientX - r.left) / r.width * (b - a)); return; } const dx = e.clientX - lastX; lastX = e.clientX; scrubTo(S.scrubT - dx / r.width * (b - a)); });
['pointerup', 'pointercancel'].forEach((ev) => bar.addEventListener(ev, () => { dragging = false; drawBar(); }));
document.querySelectorAll('#tlrow [data-z]').forEach((btn) => btn.onclick = () => { if (!S) return; S.zoomMode = btn.dataset.z; document.querySelectorAll('#tlrow [data-z]').forEach((x) => x.classList.toggle('on', x === btn)); drawBar(); });
$('skip').onclick = () => jumpTo(S.scrubT); $('back').onclick = () => jumpTo(S.scrubT); $('resume').onclick = endScrub;
$('recenter').onclick = () => setFollow(true);
addEventListener('resize', () => { drawBar(); map?.resize(); });

// ---------- demo mode: simulated drive along the route (nothing is saved) ----------
function startSim() {
  const m = S.model, det = S.model.bundle.net?.detour, sim = { s: S.snap.s, stop: false, detT: -1, detDone: !det, acc: 0 }; S.sim = sim;
  const v = 4.9, gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random());
  const DX = det ? det.path.map((p) => m.xy(p[0], p[1])) : [], detLen = DX.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - DX[i][0], p[1] - DX[i][1]), 0);
  if (det && sim.s > det.s0) sim.detDone = true;
  let t0 = performance.now();
  (function tick(now) {
    if (sim.stop || !S) return; const dt = Math.min(.5, (now - t0) / 1000) * S.speedup; t0 = now; sim.acc += dt;
    if (sim.detT < 0 && !sim.detDone && sim.s >= det.s0) sim.detT = 0;
    if (sim.detT >= 0) sim.detT += dt; else sim.s = Math.min(m.total, sim.s + v * dt);
    while (sim.acc >= 1) { sim.acc -= 1; let p;
      if (sim.detT >= 0) { const dd = sim.detT * v; if (dd >= detLen) { sim.detT = -1; sim.detDone = true; p = m.pt(sim.s); }
        else { let k = 1, run = 0; while (k < DX.length && run + Math.hypot(DX[k][0] - DX[k - 1][0], DX[k][1] - DX[k - 1][1]) < dd) { run += Math.hypot(DX[k][0] - DX[k - 1][0], DX[k][1] - DX[k - 1][1]); k++; }
          k = Math.min(k, DX.length - 1); const seg = Math.hypot(DX[k][0] - DX[k - 1][0], DX[k][1] - DX[k - 1][1]) || 1, f = (dd - run) / seg; p = [DX[k - 1][0] + (DX[k][0] - DX[k - 1][0]) * f, DX[k - 1][1] + (DX[k][1] - DX[k - 1][1]) * f]; } }
      else p = m.pt(sim.s);
      const q = m.ll(p[0] + gauss() * 4, p[1] + gauss() * 4); step(q[0], q[1], null, v); }
    requestAnimationFrame(tick);
  })(t0);
}
document.querySelectorAll('#demobar [data-x]').forEach((b) => b.onclick = () => { if (!S) return; S.speedup = +b.dataset.x; document.querySelectorAll('#demobar [data-x]').forEach((x) => x.classList.toggle('on', x === b)); });

// ---------- menu, drawer, import ----------
$('b-home').onclick = closeRoute;
// hand off to Google Maps: drive to the next point on the route (where progress is waiting), then come back to this app
$('b-gmaps').onclick = () => { if (!S) return; const q = S.model.ll(...S.model.pt(S.snap.s + 5));
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${q[0].toFixed(6)},${q[1].toFixed(6)}&travelmode=driving&dir_action=navigate`, '_blank'); };
$('b-voice').onclick = () => { voice.set(!voice.on); if (voice.on) voice.say('Voice on.'); };
$('b-menu').onclick = async () => {
  if (!S) return; const newer = catalogue.find((c) => c.id === S.entry.id);
  const choice = await modal(S.entry.name, S.demo ? 'Demo mode: progress isn’t saved.' : `Started ${new Date(S.pin.runStart).toLocaleString()}. Progress comes from the GPS log since then.${newer && newer.version !== S.pin.version ? ' A newer version of this route is available; resetting progress switches to it.' : ''}`,
    [['Export GPS data', 'sec', 'export'], ...(S.demo ? [] : [['Reset progress…', 'warn', 'reset']]), ['Close', '', null]]);
  if (choice === 'export') window.app?.exportData?.();
  if (choice === 'reset') {
    const ok = await modal('Reset all progress for this route?', 'This starts the route again from 0%. Nothing is deleted: the old route copy and the time range of its GPS log are archived on this tablet.', [['Cancel', 'sec', false], ['Reset progress', 'warn', true]]);
    if (ok) { await dbAdd(mdb, 'archive', { ...S.pin, archivedAt: Date.now() }); await dbDel(mdb, 'pins', S.pin.id); const entry = S.entry; closeRoute(); await openRoute(entry); }
  }
};
const drawer = $('drawer');
function camTab(open) { drawer.classList.toggle('open', open); document.body.classList.toggle('camopen', open); $('tab-cam').classList.toggle('on', open); $('tab-map').classList.toggle('on', !open); setTimeout(() => { map?.resize(); drawBar(); }, 260); }
$('tab-cam').onclick = () => camTab(true); $('tab-map').onclick = () => camTab(false);
$('b-drawer-home').onclick = () => camTab(true); $('b-cam').onclick = () => camTab(!drawer.classList.contains('open')); $('recpill').onclick = () => camTab(true); $('b-drawer-close').onclick = () => camTab(false);
$('b-import').onclick = () => $('import-file').click();
$('import-file').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return; e.target.value = '';
  try {
    const text = await file.text(); let bundle, name, id;
    if (/^\s*</.test(text)) { bundle = gpxToBundle(text); name = file.name.replace(/\.gpx$/i, ''); }
    else { const j = JSON.parse(text); bundle = j.nav ? j : { nav: j }; name = j.name || file.name.replace(/\.json$/i, ''); }
    id = 'local-' + (bundle.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await dbPut(mdb, 'imported', { id, name: bundle.name || name, desc: bundle.desc || `${(bundle.nav.route.at(-1)[2] / MILE).toFixed(1)} mi · added ${new Date().toLocaleDateString()}`, version: bundle.version || 'local', bundle });
    renderHome();
  } catch (err) { modal('Could not add route', String(err.message || err), [['OK', 'sec']]); }
};
// GPX track -> route with geometric turn instructions (no street names; use a prepared .json for names)
function gpxToBundle(text) {
  const pts = [...text.matchAll(/<(?:trkpt|rtept)[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g)].map((m) => [+m[1], +m[2]]);
  if (pts.length < 2) throw new Error('No track points found in GPX');
  const lat0 = pts[0][0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540, X = (p) => [p[1] * kx, p[0] * ky];
  const route = [[pts[0][0], pts[0][1], 0]];
  for (let i = 1; i < pts.length; i++) { const a = X(pts[i - 1]), b = X(pts[i]), d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d < 0.5) continue; route.push([pts[i][0], pts[i][1], route.at(-1)[2] + d]); }
  const at = (d) => { let i = route.findIndex((r) => r[2] >= d); if (i <= 0) return X(route[0]); const a = route[i - 1], b = route[i], f = (d - a[2]) / (b[2] - a[2]); return [X(a)[0] + (X(b)[0] - X(a)[0]) * f, X(a)[1] + (X(b)[1] - X(a)[1]) * f]; };
  const total = route.at(-1)[2], man = [];
  for (let d = 15; d < total - 15; d += 5) {
    const b1 = brgXY(at(d - 15), at(d)), b2 = brgXY(at(d), at(d + 15)), turn = ((b2 - b1 + 540) % 360) - 180;
    if (Math.abs(turn) < 40) continue; if (man.length && d - man.at(-1).d < 30) { if (Math.abs(turn) > Math.abs(man.at(-1).turn)) man.pop(); else continue; }
    const type = Math.abs(turn) > 140 ? 'uturn' : turn > 0 ? 'right' : 'left';
    man.push({ d, turn, type, text: type === 'uturn' ? 'Make a U-turn' : `Turn ${type}`, street: '' });
  }
  return { nav: { route, maneuvers: man.map(({ d, type, text, street }) => ({ d, type, text, street })), houses: [] } };
}

// ---------- start ----------
$('version').textContent = `Light Mapper ${VERSION}. Camera controls are in the 📷 drawer. Don’t run the old /recorder/ app at the same time.`;
if (Q.has('demo')) $('demo-toggle').checked = true;
renderHome().then(() => { const id = Q.get('route'); const e = catalogue.find((c) => c.id === id); if (e) openRoute(e); });
window.nav = { get S() { return S; }, scrubTo: (t) => scrubTo(t), jumpTo: (t) => jumpTo(t), setFollow, get map() { return map; }, openRoute, closeRoute, renderHome };
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline cache', e));
