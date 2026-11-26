// Recording loop for the THETA Z1: back-to-back clips with a watchdog.
// UI-independent so it can be tested from Node against the real camera.
import { PROP, OP, MODE_VIDEO, MODE_LIVE, shutter, shutterToString, ptpDateTime } from './ptp.js';
const fmt = (c) => (typeof c === 'number' ? '0x' + c.toString(16) : String(c));

export const DEFAULT_SETTINGS = {
  imageSize: '1920x960',
  maxClipSeconds: 1500, // 300 or 1500
  exposure: 'manual', // 'manual' | 'auto'
  iso: 1600,
  shutterDen: 160, // 1/160 s
  fNumber: 210, // f/2.1
  beepVolume: 0, // camera beeps on clip start/stop; silence them
  setClock: false, // camera clock setting disabled until verified safe (suspect in a camera hang)
};
const MAX_START_FAILURES = 2;

export class Recorder {
  constructor({ log = console.log, onStatus = () => {}, onEvent = () => {} } = {}) {
    this.log = log;
    this.onStatus = onStatus;
    this.onEvent = onEvent; // structured events for the data log (clip_start, clip_end, error...)
    this.camera = null;
    this.running = false;
    this.clip = 0;
    this.clipStartedAt = null;
    this.status = {};
    this.timer = null;
    this.busy = false;
  }

  attach(camera) { this.camera = camera; }
  detach() { this.camera = null; }

  async readInfo() {
    const c = this.camera;
    const s = {
      battery: await c.getProp(PROP.BatteryLevel),
      mode: await c.getProp(PROP.StillCaptureMode),
      imageSize: await c.getProp(PROP.ImageSize),
      maxClip: await c.getProp(PROP.MaxRecordableTime),
      captureStatus: await c.getProp(PROP.CaptureStatus),
      clipRemainingSec: await c.getProp(PROP.RemainingRecordingTime),
      dateTime: await c.getProp(PROP.DateTime),
    };
    try {
      s.exposureProgram = await c.getProp(PROP.ExposureProgram);
      s.iso = await c.getProp(PROP.ExposureIndex);
      s.shutter = shutterToString(await c.getProp(PROP.ShutterSpeed));
      s.fNumber = await c.getProp(PROP.FNumber);
    } catch (e) { /* exposure props unavailable in some modes */ }
    return s;
  }

  // Returns true if the camera had to switch out of LIVE mode (it will re-enumerate on USB).
  async ensureVideoMode() {
    const mode = await this.camera.getProp(PROP.StillCaptureMode);
    if (mode === MODE_VIDEO) return false;
    this.log(`camera mode 0x${mode.toString(16)} -> switching to video mode`);
    await this.camera.setProp(PROP.StillCaptureMode, MODE_VIDEO);
    return mode === MODE_LIVE;
  }

  async configure(settings) {
    const c = this.camera, s = { ...DEFAULT_SETTINGS, ...settings };
    const set = async (name, prop, v) => {
      try { await c.setProp(prop, v); }
      catch (e) { this.log(`WARN set ${name}=${v} failed: ${e.message}`); }
    };
    if (s.setClock) await set('DateTime', PROP.DateTime, ptpDateTime());
    await set('AudioVolume', PROP.AudioVolume, s.beepVolume);
    await set('SleepDelay', PROP.SleepDelay, 0);
    await set('AutoPowerOffDelaySec', PROP.AutoPowerOffDelaySec, 0);
    await set('ImageSize', PROP.ImageSize, s.imageSize);
    await set('MaxRecordableTime', PROP.MaxRecordableTime, s.maxClipSeconds);
    this.maxClip = s.maxClipSeconds;
    if (s.exposure === 'manual') {
      await set('ExposureProgram', PROP.ExposureProgram, 1);
      await set('ExposureIndex', PROP.ExposureIndex, s.iso);
      await set('ShutterSpeed', PROP.ShutterSpeed, shutter(1, s.shutterDen));
      await set('FNumber', PROP.FNumber, s.fNumber);
    } else {
      await set('ExposureProgram', PROP.ExposureProgram, 2);
    }
    await this.refreshStorage();
    const info = await this.readInfo();
    info.freeBytes = this.status.freeBytes;
    this.log('configured: ' + JSON.stringify(info));
    this.onEvent({ type: 'configured', settings: s, info });
    return info;
  }

  async refreshStorage() {
    try { this.status.freeBytes = await this.camera.storageFreeBytes(); this.status.freeAt = Date.now(); }
    catch (e) { this.log('storage info unavailable: ' + e.message); }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.halted = null;
    this.startFailures = 0;
    this.log('recording session started');
    this.onEvent({ type: 'session_start' });
    await this._startClip();
    this.timer = setInterval(() => this._poll(), 1000);
  }

  // Stop the polling loop without touching the camera (used when the USB link drops).
  pause() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    if (this.clipStartedAt != null) this.onEvent({ type: 'link_lost', clip: this.clip });
  }

  // Planned rollover: stop and immediately restart (used when the car is stationary so the
  // ~1.7 s camera restart gap costs no road coverage).
  async rollover(reason = 'planned_rollover') {
    if (!this.running || !this.camera || this.busy || this.clipStartedAt == null) return false;
    this.busy = true;
    try {
      if ((await this.camera.getProp(PROP.CaptureStatus)) !== 1) return false;
      const t0 = Date.now();
      await this.camera.stopRecording();
      for (let i = 0; i < 40; i++) {
        if ((await this.camera.getProp(PROP.CaptureStatus)) === 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      this._endClip(reason);
      this.onEvent({ type: 'rollover', reason, stopMs: Date.now() - t0 });
      await this._startClip();
      return true;
    } catch (e) {
      this.log('rollover error: ' + e.message);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    if (!this.camera) return;
    try {
      if ((await this.camera.getProp(PROP.CaptureStatus)) === 1) await this.camera.stopRecording();
    } catch (e) { this.log('stop error: ' + e.message); }
    this._endClip('user_stop');
    this.onEvent({ type: 'session_stop' });
    this.log('recording session stopped');
  }

  _endClip(reason) {
    if (this.clipStartedAt == null) return;
    const dur = (Date.now() - this.clipStartedAt) / 1000;
    this.onEvent({ type: 'clip_end', clip: this.clip, reason, hostSeconds: dur });
    this.log(`clip ${this.clip} ended (${reason}) after ~${dur.toFixed(1)} s`);
    this.clipStartedAt = null;
  }

  async _startClip() {
    if (!this.camera) return;
    // Never send a start while the camera is already recording (that wedged the camera once).
    try {
      if ((await this.camera.getProp(PROP.CaptureStatus)) === 1) {
        this.log('camera already recording; not sending start');
        if (this.clipStartedAt == null) { this.clip += 1; this.clipStartedAt = Date.now(); }
        return;
      }
    } catch (e) { this.log('status check before start failed: ' + e.message); return; }
    this.clip += 1;
    const t0 = Date.now();
    let replyCode = null;
    try {
      const r = await this.camera.transaction(OP.InitiateOpenCapture, [0, 0], null, true);
      replyCode = r.code;
    } catch (e) {
      replyCode = 'exception: ' + e.message;
    }
    const t1 = Date.now();
    // The reply to InitiateOpenCapture is unreliable on the Z1; trust CaptureStatus instead.
    let recording = false;
    for (let i = 0; i < 10 && !recording; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { recording = (await this.camera.getProp(PROP.CaptureStatus)) === 1; } catch (e) { /* retry */ }
    }
    const t2 = Date.now();
    if (!recording) {
      this.log(`ERROR clip ${this.clip} did not start (reply ${fmt(replyCode)})`);
      this.onEvent({ type: 'error', where: 'start', reply: fmt(replyCode) });
      this.startFailedAt = t2;
      this.startFailures = (this.startFailures || 0) + 1;
      if (this.startFailures >= MAX_START_FAILURES) {
        // Repeated start attempts may have crashed the camera once: stop retrying, ask for a human.
        this.halted = `camera refused to start ${this.startFailures}x — power-cycle the camera, then tap Start`;
        this.running = false;
        clearInterval(this.timer); this.timer = setInterval(() => this._poll(), 1000);
        this.log('HALTED: ' + this.halted);
        this.onEvent({ type: 'halted', reason: this.halted });
      }
      return;
    }
    this.startFailures = 0;
    this.clipStartedAt = t1;
    this.onEvent({ type: 'clip_start', clip: this.clip, cmdSentMs: t0, cmdAckMs: t1, confirmedMs: t2, reply: fmt(replyCode) });
    this.log(`clip ${this.clip} recording (reply ${fmt(replyCode)}, ack ${t1 - t0} ms, confirmed ${t2 - t0} ms)`);
  }

  async _poll() {
    if (!this.camera || this.busy) return;
    this.busy = true;
    try {
      const st = await this.camera.getProp(PROP.CaptureStatus);
      const recSec = await this.camera.getProp(PROP.RecordingTime);
      const now = Date.now();
      if (!this.status.lastSlow || now - this.status.lastSlow > 10000) {
        this.status.battery = await this.camera.getProp(PROP.BatteryLevel);
        this.status.clipRemainingSec = await this.camera.getProp(PROP.RemainingRecordingTime);
        this.status.lastSlow = now;
        if (st === 0 && !this.running && (!this.status.freeAt || now - this.status.freeAt > 60000)) await this.refreshStorage();
      }
      // Stall detection: recording, but the clip timer isn't advancing.
      if (st !== 1 || recSec !== this.status.recSec) this.lastRecChange = now;
      const stalled = st === 1 && this.lastRecChange && now - this.lastRecChange > 10000;
      Object.assign(this.status, { captureStatus: st, recSec, clip: this.clip, ok: true, at: now, stalled, halted: this.halted });
      if (this.running && st === 0) {
        const sinceStart = this.clipStartedAt ? now - this.clipStartedAt : Infinity;
        const sinceFail = this.startFailedAt ? now - this.startFailedAt : Infinity;
        if (sinceStart > 4000 && sinceFail > 10000) {
          // Camera stopped (hit max clip length, or something went wrong): start the next clip.
          this._endClip('camera_stopped');
          await this._startClip();
        } else if (sinceStart > 3000) {
          this.log('WARN: clip not recording 3 s after start');
        }
      }
      this.status.error = null;
    } catch (e) {
      this.status.ok = false;
      this.status.error = e.message;
      this.status.halted = this.halted;
      this.log('poll error: ' + e.message);
      this.onEvent({ type: 'error', where: 'poll', message: e.message });
    } finally {
      this.busy = false;
      this.onStatus({ ...this.status, running: this.running });
      // Near the camera's max clip length, check every 200 ms so the restart happens sooner.
      const max = this.maxClip || 1500;
      if (this.running && this.status.captureStatus === 1 && this.status.recSec >= max - 3 && !this.fastTimer) {
        this.fastTimer = setTimeout(() => { this.fastTimer = null; this._poll(); }, 200);
      }
    }
  }
}
