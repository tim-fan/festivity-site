// Minimal PTP (Picture Transfer Protocol) client over the WebUSB API.
// Works in Chrome (navigator.usb) and in Node via the `usb` package's WebUSB class.
// Written for the RICOH THETA Z1 USB API: https://github.com/ricohapi/theta-api-specs

export const OP = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetStorageInfo: 0x1005,
  GetDevicePropValue: 0x1015,
  SetDevicePropValue: 0x1016,
  TerminateOpenCapture: 0x1018,
  InitiateOpenCapture: 0x101c,
};

export const RC = {
  OK: 0x2001,
  GeneralError: 0x2002,
  SessionNotOpen: 0x2003,
  DeviceBusy: 0x2019,
  InvalidDevicePropValue: 0x201c,
  SessionAlreadyOpen: 0x201e,
};

// PTP datatypes
export const T = { UINT8: 0x2, UINT16: 0x4, UINT32: 0x6, UINT64: 0x8, STR: 0xffff };

// THETA Z1 properties used by the recorder
export const PROP = {
  BatteryLevel: [0x5001, T.UINT8],
  ImageSize: [0x5003, T.STR],
  AudioVolume: [0x502c, T.UINT32], // camera beep volume 0-100 (only settable when not recording)
  FNumber: [0x5007, T.UINT16], // 210 = f/2.1, 350, 560
  ExposureProgram: [0x500e, T.UINT16], // 1 = Manual, 2 = Auto (program)
  ExposureIndex: [0x500f, T.UINT16], // ISO; 0xFFFF = auto
  DateTime: [0x5011, T.STR],
  StillCaptureMode: [0x5013, T.UINT16], // 0x8002 video, 0x8005 live streaming
  ShutterSpeed: [0xd00f, T.UINT64], // low 32 bits numerator, high 32 bits denominator
  SleepDelay: [0xd803, T.UINT16], // 0 = off
  CaptureStatus: [0xd808, T.UINT8], // 0 idle, 1 recording
  RecordingTime: [0xd809, T.UINT16], // seconds into current clip
  RemainingRecordingTime: [0xd80a, T.UINT16], // seconds left on storage at current settings
  AutoPowerOffDelaySec: [0xd81b, T.UINT32], // 0 = off
  MaxRecordableTime: [0xd823, T.UINT16], // 300 or 1500 seconds per clip
};

export const MODE_VIDEO = 0x8002;
export const MODE_LIVE = 0x8005;
export const RICOH_VENDOR_ID = 0x05ca;

const CMD = 1, DATA = 2, RESP = 3;
// Android limits a single bulk transfer to 16 KB; larger reads fail with a transfer error.
const READ_SIZE = 16384;

export class PtpError extends Error {
  constructor(op, code) {
    super(`PTP op 0x${op.toString(16)} failed: 0x${code.toString(16)}`);
    this.op = op;
    this.code = code;
  }
}

export class PtpCamera {
  constructor(device) {
    this.device = device;
    this.transactionId = 0;
    this.queue = Promise.resolve();
  }

  async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    // Find the still-image (PTP) interface: class 6
    for (const iface of d.configuration.interfaces) {
      const alt = iface.alternates[0];
      if (alt.interfaceClass !== 6) continue;
      this.ifaceNum = iface.interfaceNumber;
      for (const ep of alt.endpoints) {
        if (ep.type === 'bulk' && ep.direction === 'in') this.epIn = ep.endpointNumber;
        if (ep.type === 'bulk' && ep.direction === 'out') this.epOut = ep.endpointNumber;
      }
    }
    if (this.ifaceNum === undefined) throw new Error('No PTP interface found (camera in LIVE mode?)');
    await d.claimInterface(this.ifaceNum);
    const r = await this.transaction(OP.OpenSession, [1], null, true);
    if (r.code !== RC.OK && r.code !== RC.SessionAlreadyOpen) throw new PtpError(OP.OpenSession, r.code);
  }

  async close() {
    try { await this.transaction(OP.CloseSession, [], null, true); } catch (e) { /* ignore */ }
    try { await this.device.releaseInterface(this.ifaceNum); } catch (e) { /* ignore */ }
    try { await this.device.close(); } catch (e) { /* ignore */ }
  }

  // Serialize all transactions: USB PTP is strictly one-at-a-time.
  transaction(op, params = [], dataOut = null, allowFail = false, timeoutMs = 10000) {
    const run = () => withTimeout(this._transaction(op, params, dataOut, allowFail), timeoutMs,
      `PTP op 0x${op.toString(16)} timed out`);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _transaction(op, params, dataOut, allowFail) {
    const tid = ++this.transactionId;
    const cmd = new DataView(new ArrayBuffer(12 + 4 * params.length));
    cmd.setUint32(0, cmd.byteLength, true);
    cmd.setUint16(4, CMD, true);
    cmd.setUint16(6, op, true);
    cmd.setUint32(8, tid, true);
    params.forEach((p, i) => cmd.setUint32(12 + 4 * i, p >>> 0, true));
    await this._out(cmd.buffer);

    if (dataOut) {
      const payload = new Uint8Array(dataOut);
      const buf = new Uint8Array(12 + payload.length);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, buf.length, true);
      dv.setUint16(4, DATA, true);
      dv.setUint16(6, op, true);
      dv.setUint32(8, tid, true);
      buf.set(payload, 12);
      await this._out(buf.buffer);
    }

    let data = null;
    for (;;) {
      const c = await this._readContainer();
      if (c.tid !== tid) { // stale/mismatched container from an earlier transaction: skip it
        if (this.onStale) this.onStale(c, tid);
        continue;
      }
      if (c.type === DATA) { data = c.payload; continue; }
      if (c.type === RESP) {
        const pv = new DataView(c.payload.buffer, c.payload.byteOffset, c.payload.byteLength);
        const rparams = [];
        for (let i = 0; i + 4 <= c.payload.byteLength; i += 4) rparams.push(pv.getUint32(i, true));
        if (c.code !== RC.OK && !allowFail) throw new PtpError(op, c.code);
        return { code: c.code, params: rparams, data };
      }
    }
  }

  async _out(buffer) {
    const r = await this.device.transferOut(this.epOut, buffer);
    if (r.status !== 'ok') throw new Error('transferOut ' + r.status);
  }

  async _readContainer() {
    let r = await this.device.transferIn(this.epIn, READ_SIZE);
    if (r.status !== 'ok') throw new Error('transferIn ' + r.status);
    let chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    while (chunk.length === 0) { // zero-length packet; read again
      r = await this.device.transferIn(this.epIn, READ_SIZE);
      chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }
    const hv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const len = hv.getUint32(0, true);
    const type = hv.getUint16(4, true);
    const code = hv.getUint16(6, true);
    const tid = len >= 12 ? hv.getUint32(8, true) : 0;
    const all = new Uint8Array(len);
    all.set(chunk.subarray(0, Math.min(len, chunk.length)));
    let got = chunk.length;
    while (got < len) {
      r = await this.device.transferIn(this.epIn, READ_SIZE);
      const c = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      all.set(c.subarray(0, Math.min(c.length, len - got)), got);
      got += c.length;
    }
    return { type, code, tid, payload: all.subarray(12) };
  }

  async getProp([code, type]) {
    const r = await this.transaction(OP.GetDevicePropValue, [code]);
    return decode(r.data, type);
  }

  async setProp([code, type], value) {
    await this.transaction(OP.SetDevicePropValue, [code], encode(value, type));
  }

  // Free bytes on the first storage (PTP StorageInfo dataset: FreeSpaceInBytes is a UINT64 at offset 14).
  async storageFreeBytes() {
    const ids = await this.transaction(OP.GetStorageIDs);
    const dv = new DataView(ids.data.buffer, ids.data.byteOffset, ids.data.byteLength);
    if (dv.getUint32(0, true) < 1) throw new Error('no storage');
    const info = await this.transaction(OP.GetStorageInfo, [dv.getUint32(4, true)]);
    const iv = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    return Number(iv.getBigUint64(14, true));
  }

  // All object handles on the camera (only works while not recording).
  async objectHandles() {
    const h = await this.transaction(0x1007, [0xffffffff, 0, 0]);
    const dv = new DataView(h.data.buffer, h.data.byteOffset, h.data.byteLength);
    const n = dv.getUint32(0, true), out = [];
    for (let i = 0; i < n; i++) out.push(dv.getUint32(4 + 4 * i, true));
    return out;
  }

  // Wait until a handle not in `before` appears (a just-finished clip can take a moment to be listed).
  // Returns it, or null if nothing new shows up within timeoutMs. Never guesses.
  async waitForNewObject(before, timeoutMs = 8000) {
    const known = new Set(before), t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const fresh = (await this.objectHandles()).filter((h) => !known.has(h));
        if (fresh.length) return Math.max(...fresh);
      } catch (e) { /* busy while finalising: retry */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  // JPEG thumbnail (Blob) of an object; the Z1 gives a 640x320 dual-fisheye frame for videos.
  async thumbnail(handle) {
    const r = await this.transaction(0x100a, [handle], null, false, 15000);
    return new Blob([r.data], { type: 'image/jpeg' });
  }

  deleteObject(handle) { return this.transaction(0x100b, [handle, 0]); }

  startRecording() { return this.transaction(OP.InitiateOpenCapture, [0, 0]); }
  stopRecording() { return this.transaction(OP.TerminateOpenCapture, [0xffffffff]); }
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })])
    .finally(() => clearTimeout(t));
}

export function encode(v, type) {
  switch (type) {
    case T.UINT8: return new Uint8Array([v]).buffer;
    case T.UINT16: { const b = new DataView(new ArrayBuffer(2)); b.setUint16(0, v, true); return b.buffer; }
    case T.UINT32: { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v, true); return b.buffer; }
    case T.UINT64: { const b = new DataView(new ArrayBuffer(8)); b.setBigUint64(0, BigInt(v), true); return b.buffer; }
    case T.STR: {
      if (!v) return new Uint8Array([0]).buffer;
      const n = v.length + 1;
      const b = new DataView(new ArrayBuffer(1 + 2 * n));
      b.setUint8(0, n);
      for (let i = 0; i < v.length; i++) b.setUint16(1 + 2 * i, v.charCodeAt(i), true);
      return b.buffer;
    }
  }
  throw new Error('unsupported type ' + type);
}

export function decode(data, type) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (type) {
    case T.UINT8: return dv.getUint8(0);
    case T.UINT16: return dv.getUint16(0, true);
    case T.UINT32: return dv.getUint32(0, true);
    case T.UINT64: return dv.getBigUint64(0, true);
    case T.STR: {
      const n = dv.getUint8(0);
      let s = '';
      for (let i = 0; i < n - 1; i++) s += String.fromCharCode(dv.getUint16(1 + 2 * i, true));
      return s;
    }
  }
  throw new Error('unsupported type ' + type);
}

// Shutter speed helpers: value is (denominator << 32) | numerator
export const shutter = (num, den) => (BigInt(den) << 32n) | BigInt(num);
export const shutterToString = (v) => {
  const num = Number(v & 0xffffffffn), den = Number(v >> 32n);
  return den === 1 ? `${num}s` : `${num}/${den}`;
};

// Camera DateTime string, in the camera's local time with offset, e.g. 20261125T170030-0800
export function ptpDateTime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}
