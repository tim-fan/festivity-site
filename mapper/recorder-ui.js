// Light Mapper: recorder side (copied from webapp/app.js with three small hooks for the mapper:
// GPS fixes are re-broadcast as a 'gpsfix' event for navigation, the status banner is mirrored onto the
// map's #recpill, and the service worker is registered by nav.js). Camera logic is unchanged.
import { PtpCamera, RICOH_VENDOR_ID, PROP } from './ptp.js';
import { Recorder, DEFAULT_SETTINGS, LOW_FPS_SIZES } from './recorder.js';
import { renderCharts } from './charts.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'theta-settings';
const APP_VERSION = 'mapper-2026-11-27.4';
const qsTelemetry = new URLSearchParams(location.search).get('telemetry');
if (qsTelemetry !== null) localStorage.setItem('theta-telemetry', qsTelemetry); // ?telemetry= (empty) turns it off
const TELEMETRY = location.hostname === 'localhost' ? '/api/log' : (localStorage.getItem('theta-telemetry') || null);

// ---------- logging ----------
const logLines = [];
let pendingLogs = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  pendingLogs.push({ t: Date.now(), msg });
  $('log').textContent = logLines.slice().reverse().join('\n');
  console.log(msg);
}
window.addEventListener('error', (e) => log('JS ERROR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => log('JS ERROR (promise): ' + (e.reason?.message ?? e.reason)));

// ---------- storage (IndexedDB) ----------
let db;
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('theta-recorder', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('fixes', { autoIncrement: true });
    req.result.createObjectStore('events', { autoIncrement: true });
  };
  req.onsuccess = () => { db = req.result; resolve(); };
  req.onerror = () => reject(req.error);
});
async function put(store, obj) {
  await dbReady;
  db.transaction(store, 'readwrite').objectStore(store).add(obj);
}
async function getAll(store) {
  await dbReady;
  return new Promise((res) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
  });
}

let pendingEvents = [];
function event(e) {
  const rec = { t: Date.now(), mono: performance.now(), ...e };
  put('events', rec);
  pendingEvents.push(rec);
}

// ---------- settings ----------
const SETTINGS_VERSION = 2; // bump to make every device adopt new defaults once
function loadSettings() {
  if (localStorage.getItem('theta-settings-version') !== String(SETTINGS_VERSION)) {
    localStorage.removeItem(SETTINGS_KEY); localStorage.setItem('theta-settings-version', String(SETTINGS_VERSION));
  }
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function initSettingsUI() {
  const isos = [80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400];
  const shutters = [30, 40, 50, 60, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000];
  $('s-iso').innerHTML = isos.map((v) => `<option>${v}</option>`).join('');
  $('s-shutter').innerHTML = shutters.map((v) => `<option>${v}</option>`).join('');
  const s = loadSettings();
  $('s-exposure').value = s.exposure; $('s-iso').value = s.iso; $('s-shutter').value = s.shutterDen; $('s-clip').value = s.maxClipSeconds; $('s-size').value = s.imageSize;
}
function readSettingsUI() {
  const s = {
    exposure: $('s-exposure').value, iso: +$('s-iso').value, shutterDen: +$('s-shutter').value,
    fNumber: 210, maxClipSeconds: +$('s-clip').value, imageSize: $('s-size').value,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  return s;
}

// ---------- tablet battery ----------
let tabletBattery = null;
navigator.getBattery?.().then((b) => { tabletBattery = b; b.addEventListener('levelchange', () => render()); b.addEventListener('chargingchange', () => render()); }).catch(() => {});

// ---------- camera ----------
let camera = null;
let wantRunning = localStorage.getItem('theta-want-running') === '1'; // user intent; survives reconnects and reloads
const setWant = (v) => { wantRunning = v; localStorage.setItem('theta-want-running', v ? '1' : '0'); };
let lastStatus = {};
const recorder = new Recorder({ log, onEvent: event, onStatus: (s) => { lastStatus = s; render(); } });

async function attach(device) {
  if (camera) return;
  log(`connecting to ${device.productName} (pid ${device.productId.toString(16)})`);
  const cam = new PtpCamera(device);
  cam.onStale = (c, tid) => log(`skipped stale PTP container (tid ${c.tid}, expected ${tid}, code 0x${c.code.toString(16)})`);
  try {
    await cam.open();
  } catch (e) {
    log('open failed: ' + e.message + (device.productId === 0x2715 ? ' — camera is in LIVE mode; switch it to video mode with the Mode button' : ''));
    return;
  }
  camera = cam;
  recorder.attach(cam);
  event({ type: 'camera_connected' });
  try {
    let recording = false;
    try { recording = (await cam.getProp(PROP.CaptureStatus)) === 1; } catch (e) { /* ignore */ }
    if (recording) {
      log('camera is already recording — leaving its settings alone and resuming');
    } else {
      if (await recorder.ensureVideoMode()) { log('camera switching out of LIVE mode; it will reconnect'); return; }
      await recorder.configure(readSettingsUI());
    }
  } catch (e) { log('configure failed: ' + e.message); }
  recorder.watch();
  if (wantRunning) await recorder.start();
  render();
}

function detach(reason) {
  if (!camera) return;
  log('camera disconnected: ' + reason);
  event({ type: 'camera_disconnected', reason });
  recorder.pause();
  recorder.detach();
  camera = null;
  render();
}

async function connectClicked() {
  try {
    const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: RICOH_VENDOR_ID }] });
    await attach(dev);
  } catch (e) { log('connect: ' + e.message); }
}

async function autoConnect() {
  if (!navigator.usb) { log('WebUSB not available in this browser (use Chrome, https or localhost)'); return; }
  navigator.usb.addEventListener('connect', (e) => { if (e.device.vendorId === RICOH_VENDOR_ID) attach(e.device); });
  navigator.usb.addEventListener('disconnect', (e) => { if (camera && e.device === camera.device) detach('usb unplugged'); });
  const devs = (await navigator.usb.getDevices()).filter((d) => d.vendorId === RICOH_VENDOR_ID);
  if (devs.length) await attach(devs[0]);
}

// ---------- GPS ----------
let lastFix = null;
let pendingFixes = 0;
let pendingFixList = [];
function startGps() {
  if (!navigator.geolocation) { log('no geolocation'); return; }
  navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    lastFix = { t: p.timestamp, now: Date.now(), mono: performance.now(), lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, spd: c.speed, hdg: c.heading };
    put('fixes', lastFix);
    window.dispatchEvent(new CustomEvent('gpsfix', { detail: lastFix }));
    pendingFixes++;
    pendingFixList.push(lastFix);
    if (pendingFixList.length > 20000) pendingFixList.shift();
    render();
  }, (err) => log('GPS error: ' + err.message), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

// ---------- planned rollover while stationary ----------
// Uses GPS-reported speed (Doppler-based, far steadier than position changes).
const rolloverAfterSec = () => Math.round((recorder.maxClip || 1500) * 0.6); // from 60% into a clip (15 of 25 min, 30 of 50)...
let stoppedSince = null;
setInterval(async () => {
  const fresh = lastFix && Date.now() - lastFix.t < 2500;
  const slow = fresh && lastFix.spd != null && lastFix.spd < 0.5 && lastFix.acc != null && lastFix.acc < 30;
  stoppedSince = slow ? (stoppedSince ?? Date.now()) : null;
  // ...roll over at the first moment the car has been stopped for 3 s.
  if (wantRunning && recorder.running && lastStatus.captureStatus === 1 && lastStatus.recSec >= rolloverAfterSec() &&
      stoppedSince && Date.now() - stoppedSince > 3000) {
    log(`car stopped at clip time ${lastStatus.recSec} s — rolling over to a new clip now`);
    stoppedSince = null;
    await recorder.rollover('stationary');
  }
}, 500);

// ---------- hourly mount check: a gentle reminder card every hour of recording ----------
const MOUNT_CHECK_MS = 60 * 60 * 1000;
let lastMountCheck = Number(localStorage.getItem('theta-last-mount-check')) || null;
function showMountCheck() {
  $('mount-check').hidden = false;
  if (audio) { const o = audio.createOscillator(), g = audio.createGain(); o.type = 'sine'; o.frequency.value = 880; // one soft ping
    g.gain.setValueAtTime(0.15, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.6); }
  event({ type: 'mount_check_prompt' });
}
setInterval(() => {
  if (!wantRunning || !sessionStart || !$('mount-check').hidden) return;
  const since = lastMountCheck && lastMountCheck > sessionStart ? lastMountCheck : sessionStart;
  if (Date.now() - since > MOUNT_CHECK_MS) showMountCheck();
}, 5000);
$('b-mount-ok').onclick = () => {
  lastMountCheck = Date.now(); localStorage.setItem('theta-last-mount-check', String(lastMountCheck));
  $('mount-check').hidden = true; event({ type: 'mount_check_done' }); log('mount checked');
};

// ---------- camera view (thumbnails: pre-drive check + each stationary rollover) ----------
const THUMB_KEY = 'theta-last-thumb';
function setThumb(src, labelText) {
  const img = $('cam-view');
  img.onerror = () => { img.hidden = true; $('cam-view-label').textContent = '(tap “Check camera view”, or wait for a stop-sign rollover)'; };
  img.src = src; img.hidden = false;
  $('cam-view-label').textContent = labelText;
}
async function showThumb(blobs, label) {
  const labelText = `— ${label} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const list = Array.isArray(blobs) ? blobs : [blobs];
  const imgs = await Promise.all(list.map((b) => createImageBitmap(b)));
  const h = 320, ws = imgs.map((im) => Math.round(im.width * h / im.height));
  const cv = document.createElement('canvas'); cv.width = ws.reduce((a, b) => a + b, 0); cv.height = h;
  const ctx = cv.getContext('2d'); let x = 0;
  imgs.forEach((im, i) => { ctx.drawImage(im, x, 0, ws[i], h); x += ws[i]; });
  const src = cv.toDataURL('image/jpeg', 0.85); // data URL so it survives reloads
  setThumb(src, labelText);
  try { localStorage.setItem(THUMB_KEY, JSON.stringify({ src, label: labelText })); } catch { /* storage full: show only */ }
}
try { const t = JSON.parse(localStorage.getItem(THUMB_KEY) || 'null'); if (t?.src) setThumb(t.src, t.label); } catch { /* none saved */ }
recorder.onThumbnail = showThumb;
$('b-check').onclick = async () => {
  $('b-check').disabled = true; $('cam-view-label').textContent = 'recording a 3 s test clip…';
  try { showThumb(await recorder.checkView(), 'view check'); log('view check done (test clip deleted)'); }
  catch (e) { $('cam-view-label').textContent = 'check failed: ' + e.message; log('view check failed: ' + e.message); }
  finally { $('b-check').disabled = false; render(); }
};

// ---------- wake lock ----------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { log('wake lock: ' + e.message); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

// ---------- alarm ----------
// Browsers only allow sound after a user gesture: unlock audio on the first tap anywhere.
let audio;
document.addEventListener('pointerdown', () => { audio ??= new AudioContext(); audio.resume(); }, { capture: true });
function tone(freq, dur) {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.35;
  o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + dur);
}
// Alarm mute (mapper): silences beeps + vibration only. Not persisted: every app launch starts with alarms ON.
let alarmsMuted = false;
function setAlarmsMuted(v) {
  alarmsMuted = v; log(v ? 'recording alarms muted (banner still shows problems)' : 'recording alarms on');
  for (const id of ['b-alarm', 'b-alarm2']) { const el = $(id); if (el) { el.textContent = v ? '🔕' : '🔔'; el.title = v ? 'Recording alarms muted: tap to turn on' : 'Mute recording alarms'; el.classList.toggle('muted', v); } }
}
for (const id of ['b-alarm', 'b-alarm2']) { const el = $(id); if (el) el.onclick = () => setAlarmsMuted(!alarmsMuted); }
function alarmSound(level) {
  if (alarmsMuted) return;
  if (level === 'err') { tone(1000, 0.2); setTimeout(() => tone(700, 0.2), 250); navigator.vibrate?.([300, 100, 300]); }
  else { tone(600, 0.15); }
}
// Returns { level: 'err' | 'warn', msg } or null when all is well.
function alarmState() {
  const s = lastStatus;
  if (wantRunning) {
    if (s.halted) return { level: 'err', msg: s.halted.toUpperCase() };
    if (!camera) return { level: 'err', msg: 'CAMERA DISCONNECTED' };
    if (s.ok === false) return { level: 'err', msg: 'CAMERA NOT RESPONDING' };
    if (!s.at || Date.now() - s.at > 10000) return { level: 'err', msg: 'NO STATUS FROM CAMERA' };
    if (s.stalled) return { level: 'err', msg: 'CLIP TIMER STUCK' };
    if (s.captureStatus !== 1 && (!recorder.clipStartedAt || Date.now() - recorder.clipStartedAt > 8000))
      return { level: 'err', msg: 'NOT RECORDING' };
  }
  if (!lastFix || Date.now() - lastFix.t > 30000) return { level: 'warn', msg: 'NO GPS FIX' };
  return null;
}
setInterval(() => { const a = alarmState(); if (a && (a.level === 'err' || wantRunning)) alarmSound(a.level); render(); }, 2500);

// ---------- render ----------
let sessionStart = wantRunning ? Date.now() : null;
const fmtDur = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
const BITRATE = { '1920x960': 19.5e6, '3840x1920': 56e6, '2688x2688': 24.6e6, '3648x3648': 41e6 }; // bits/s, measured
const bytesPerSec = (size) => (BITRATE[size] || 19.5e6) / 8;
function render() {
  const b = $('banner'), a = alarmState();
  if (a?.level === 'err') { b.className = 'err'; b.textContent = '⚠ ' + a.msg; }
  else if (wantRunning && lastStatus.captureStatus === 1) { b.className = 'rec'; b.textContent = '● RECORDING' + (a ? ' – ' + a.msg : ''); }
  else if (wantRunning) { b.className = 'warn'; b.textContent = 'STARTING…'; }
  else if (camera) { b.className = 'warn'; b.textContent = 'CONNECTED – NOT RECORDING'; }
  else { b.className = 'warn'; b.textContent = 'CAMERA NOT CONNECTED'; }
  const pill = $('recpill'); if (pill) { pill.className = b.className; pill.textContent = b.textContent; }
  const tc = $('tab-cam'); if (tc) { tc.dataset.st = b.className; tc.title = b.textContent; }
  $('t-clip').textContent = recorder.clip || '–';
  $('t-rec').textContent = lastStatus.recSec != null ? fmtDur(lastStatus.recSec) : '–';
  $('t-batt').textContent = camera && lastStatus.battery != null ? lastStatus.battery + '%' : '–';
  $('t-tbatt').textContent = tabletBattery ? `${Math.round(tabletBattery.level * 100)}%${tabletBattery.charging ? ' ⚡' : ''}` : '–';
  if (lastStatus.freeBytes != null) {
    let free = lastStatus.freeBytes;
    if (wantRunning && lastStatus.freeAt) free -= (Date.now() - lastStatus.freeAt) / 1000 * bytesPerSec($('s-size').value);
    $('t-store').textContent = `${fmtDur(Math.max(0, free) / bytesPerSec($('s-size').value))}`;
  } else $('t-store').textContent = '–';
  $('t-gps').textContent = lastFix ? `±${Math.round(lastFix.acc)} m, ${Math.round((Date.now() - lastFix.t) / 1000)} s` : 'no fix';
  $('t-sess').textContent = sessionStart ? fmtDur((Date.now() - sessionStart) / 1000) : '–';
  // One primary action at a time: Connect -> Start -> Stop (state lives in the banner).
  const show = (id, on) => { $(id).hidden = !on; };
  show('b-connect', !camera);
  show('b-start', !!camera && (!wantRunning || !!lastStatus.halted));
  show('b-stop', wantRunning);
  $('b-start').textContent = lastStatus.halted ? 'Retry start' : 'Start recording';
  $('b-apply').disabled = !camera || wantRunning;
  $('b-check').hidden = !camera || wantRunning;
}

// ---------- session charts: battery + storage samples every 30 s, last 2 h (persisted) ----------
const SAMPLES_KEY = 'theta-samples';
let samples = [];
try { samples = JSON.parse(localStorage.getItem(SAMPLES_KEY) || '[]'); } catch { samples = []; }
function freeBytesNow() {
  const s = lastStatus;
  if (s.freeBytes == null || !s.freeAt) return [null, false];
  const age = (Date.now() - s.freeAt) / 1000;
  if (wantRunning && lastStatus.captureStatus === 1 && age > 70) // stale reading while recording: estimate
    return [Math.max(0, s.freeBytes - age * bytesPerSec($('s-size').value)), true];
  return [s.freeBytes, false];
}
function takeSample() {
  const [free, est] = freeBytesNow();
  const s = {
    t: Date.now(),
    cam: camera && lastStatus.battery != null ? lastStatus.battery : null,
    tab: tabletBattery ? Math.round(tabletBattery.level * 100) : null,
    tabCharging: tabletBattery ? tabletBattery.charging : null,
    freeH: camera && free != null ? free / bytesPerSec($('s-size').value) / 3600 : null,
    freeEst: est || undefined,
  };
  samples.push(s);
  samples = samples.filter((x) => x.t > Date.now() - 2 * 3600e3);
  localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples));
  drawCharts();
}
function drawCharts() {
  try { renderCharts(samples, bytesPerSec($('s-size').value)); } catch (e) { console.warn('charts', e); }
}
setTimeout(takeSample, 3000);
setInterval(takeSample, 30000);

// ---------- export ----------
async function exportData() {
  const fixes = await getAll('fixes'), events = await getAll('events');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="theta-recorder" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>\n` +
    fixes.map((f) => `<trkpt lat="${f.lat}" lon="${f.lon}"><time>${new Date(f.t).toISOString()}</time>${f.alt != null ? `<ele>${f.alt}</ele>` : ''}</trkpt>`).join('\n') +
    `\n</trkseg></trk></gpx>\n`;
  download(`theta-recorder-gps-${stamp}.gpx`, gpx, 'application/gpx+xml');
  download(`theta-recorder-data-${stamp}.json`, JSON.stringify({ fixes, events }, null, 1), 'application/json');
  log(`exported ${fixes.length} fixes, ${events.length} events`);
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- telemetry back to the dev server ----------
async function sendTelemetry() {
  if (!TELEMETRY) return;
  const body = {
    t: Date.now(), status: lastStatus, wantRunning, connected: !!camera, clip: recorder.clip,
    alarm: alarmState(), lastFix, newFixes: pendingFixes, fixes: pendingFixList, logs: pendingLogs, events: pendingEvents,
    ua: navigator.userAgent, visible: document.visibilityState,
  };
  const logs = pendingLogs, events = pendingEvents, nf = pendingFixes, fl = pendingFixList;
  pendingLogs = []; pendingEvents = []; pendingFixes = 0; pendingFixList = [];
  try {
    await fetch(TELEMETRY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    pendingLogs = logs.concat(pendingLogs).slice(-500); pendingEvents = events.concat(pendingEvents); pendingFixes += nf; pendingFixList = fl.concat(pendingFixList).slice(-20000);
  }
}
setInterval(sendTelemetry, 5000);

// ---------- wiring ----------
$('b-connect').onclick = connectClicked;
$('b-start').onclick = async () => {
  if (!wantRunning) sessionStart = Date.now();
  setWant(true); keepAwake(); render();
  if (recorder.running) return;
  await recorder.start();
};
$('b-stop').onclick = async () => { setWant(false); sessionStart = null; await recorder.stop(); render(); await exportData(); };
$('b-apply').onclick = async () => { if (camera) await recorder.configure(readSettingsUI()); };
$('b-export').onclick = exportData;
$('b-clear').onclick = async () => {
  if (!confirm('Delete all stored GPS fixes and events from this device?')) return;
  await dbReady;
  for (const s of ['fixes', 'events']) db.transaction(s, 'readwrite').objectStore(s).clear();
  log('stored data cleared');
};

// Handle for remote debugging via Chrome DevTools
window.app = { setAlarmsMuted, get alarmsMuted() { return alarmsMuted; }, showMountCheck, recorder, get camera() { return camera; }, log, exportData, getAll, get status() { return lastStatus; } };

navigator.storage?.persist?.().then((ok) => log('persistent storage: ' + (ok ? 'granted' : 'NOT granted (data may be evicted if the tablet runs low on space)')));
event({ type: 'clock_anchor', wall: Date.now(), timeOrigin: performance.timeOrigin });
setInterval(() => event({ type: 'clock_anchor', wall: Date.now(), timeOrigin: performance.timeOrigin }), 60000);
initSettingsUI();
startGps();
keepAwake();
autoConnect();
render();
log(`Light Mapper recorder ${APP_VERSION} loaded` + (TELEMETRY ? ` (telemetry -> ${TELEMETRY})` : ''));
