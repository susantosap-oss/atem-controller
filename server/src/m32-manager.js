/**
 * M32Manager — Midas M32R OSC UDP manager.
 * Controls MixBus sends, channel levels, and bus masters via OSC on port 10023.
 * No external dependencies — uses a minimal OSC 1.0 encoder/decoder.
 *
 * OSC flow:
 *   /xremote             → subscribe to parameter-change push (renew every 9s)
 *   /ch/NN/config/name   → get channel name (M32 responds)
 *   /bus/NN/config/name  → get bus name
 *   /bus/NN/config/ms    → get mono/stereo (0=stereo, 1=mono)
 *   /ch/NN/mix/MM/level  → channel NN send level to bus MM (float 0.0-1.0)
 *   /ch/NN/mix/MM/on     → channel NN send on/off to bus MM (int 0/1)
 *   /bus/NN/mix/level    → bus NN master fader
 *   /bus/NN/mix/on       → bus NN master on/off
 *   /meters <str>        → request meter blob (M32 replies with /meters/1, /meters/5, etc.)
 */

'use strict';

const dgram        = require('dgram');
const EventEmitter = require('events');

const M32_PORT          = 10023;
const XREMOTE_INTERVAL  = 9_000;   // ms — must renew before 10s timeout
const METER_INTERVAL    = 80;      // ms — ~12fps meter poll

// ── Minimal OSC 1.0 encode / decode (big-endian) ─────────────

function padLen(n) {
  const r = n % 4;
  return r === 0 ? n : n + (4 - r);
}

function encStr(str) {
  const src = Buffer.from(str + '\0', 'utf8');
  const buf = Buffer.alloc(padLen(src.length));
  src.copy(buf);
  return buf;
}

function oscEncode(address, args = []) {
  const parts = [encStr(address)];
  let typeTag = ',';
  const argParts = [];

  for (const a of args) {
    const t = a.type;
    if (t === 'i' || t === 'integer') {
      typeTag += 'i';
      const b = Buffer.alloc(4); b.writeInt32BE(a.value >>> 0, 0); // unsigned guard
      b.writeInt32BE(a.value | 0, 0);
      argParts.push(b);
    } else if (t === 'f' || t === 'float') {
      typeTag += 'f';
      const b = Buffer.alloc(4); b.writeFloatBE(a.value, 0);
      argParts.push(b);
    } else if (t === 's' || t === 'string') {
      typeTag += 's';
      argParts.push(encStr(a.value));
    }
  }

  parts.push(encStr(typeTag));
  parts.push(...argParts);
  return Buffer.concat(parts);
}

function readStr(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString('utf8', off, end);
  return { value, next: off + padLen(end - off + 1) };
}

function oscDecode(buf) {
  try {
    let off = 0;
    const addrR = readStr(buf, off);
    if (!addrR.value.startsWith('/')) return null;
    off = addrR.next;
    if (off >= buf.length) return { address: addrR.value, args: [] };

    const tagR = readStr(buf, off);
    off = tagR.next;
    const types = tagR.value.startsWith(',') ? tagR.value.slice(1) : tagR.value;

    const args = [];
    for (const t of types) {
      if (off >= buf.length) break;
      if (t === 'f') {
        args.push({ type: 'float', value: buf.readFloatBE(off) }); off += 4;
      } else if (t === 'i') {
        args.push({ type: 'int', value: buf.readInt32BE(off) }); off += 4;
      } else if (t === 's') {
        const sr = readStr(buf, off);
        args.push({ type: 'string', value: sr.value }); off = sr.next;
      } else if (t === 'b') {
        const blen = buf.readInt32BE(off); off += 4;
        const blob = Buffer.from(buf.slice(off, off + blen));
        args.push({ type: 'blob', value: blob }); off += padLen(blen);
      }
    }
    return { address: addrR.value, args };
  } catch (_) { return null; }
}

// FxRtn fallback names when device returns empty
const FXRTN_DEFAULT = ['FxRtn 1', 'FxRtn 2', 'FxRtn 3', 'FxRtn 4'];

// M32 FxRtn: 8 OSC channels in 4 stereo pairs (01+02, 03+04, 05+06, 07+08).
// App shows 4 logical channels (01-04), each mapping to one stereo pair leader.
function fxLogicalToOsc(logCh) {
  return String((parseInt(logCh) - 1) * 2 + 1).padStart(2, '0');
}
function fxOscToLogical(oscCh) {
  return String(Math.ceil(parseInt(oscCh) / 2)).padStart(2, '0');
}

// ── M32 level/dB curve ────────────────────────────────────────
// Breakpoints (raw 0-1 ↔ dBu): 0.0=-90, 0.25=-40, 0.5=-20, 0.75=0, 1.0=+10
const CURVE = [[0.00,-90],[0.25,-40],[0.50,-20],[0.75,0],[1.00,10]];

function m32ToDb(v) {
  if (v <= 0) return -90;
  if (v >= 1) return 10;
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [x0,y0] = CURVE[i], [x1,y1] = CURVE[i+1];
    if (v >= x0 && v <= x1) {
      const t = (v - x0) / (x1 - x0);
      return Math.round((y0 + t * (y1 - y0)) * 10) / 10;
    }
  }
  return -90;
}

function dbToM32(db) {
  if (db <= -90) return 0;
  if (db >= 10)  return 1;
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [x0,y0] = CURVE[i], [x1,y1] = CURVE[i+1];
    if (db >= y0 && db <= y1) {
      const t = (db - y0) / (y1 - y0);
      return Math.round((x0 + t * (x1 - x0)) * 1000) / 1000;
    }
  }
  return 0;
}

function linToDbFS(v) {
  if (v <= 0) return -90;
  return Math.max(-90, Math.round(10 * Math.log10(v) * 10) / 10);
}

// ── Meter blob parser ─────────────────────────────────────────
// M32/X32 blob: 4-byte LE int32 (count) + count × LE float32
// M32 may send mono (1 float/ch) or stereo pairs (2 floats/ch).
// Auto-detect: if count >= numCh*2 → stereo pairs, else → mono.

function parseMeterBlob(blob, numCh) {
  if (!blob || blob.length < 8) return null;
  try {
    const countLE  = blob.readInt32LE(0);
    const expected = countLE * 4;
    const offset   = (expected > 0 && expected <= blob.length - 4) ? 4 : 0;

    // Stereo only when count header is valid (offset=4) and exactly 2 floats/ch.
    // If offset=0 (no valid LE header), fall back to blob-size detection.
    // Avoid false-stereo when M32 sends extended mono blobs (e.g. 72 floats for 32 ch).
    const stereo = offset === 4
      ? countLE === numCh * 2
      : blob.length >= numCh * 8;
    const stride = stereo ? 8 : 4;

    const result = {};
    for (let i = 0; i < numCh; i++) {
      const lo = offset + i * stride;
      if (lo + 4 > blob.length) break;
      const lv = blob.readFloatLE(lo);
      let rv = lv;
      if (stereo) {
        const ro = lo + 4;
        if (ro + 4 <= blob.length) rv = blob.readFloatLE(ro);
      }
      const key = String(i + 1).padStart(2, '0');
      result[key] = {
        left:  linToDbFS(lv),
        right: linToDbFS(rv),
      };
    }
    return Object.keys(result).length ? result : null;
  } catch (_) { return null; }
}

// One-shot raw dump of a /meters/N blob: byte length, parsed LE int32 header,
// detected stride, and every float value (raw linear + dBFS). Logged once per
// connection so a live session can capture ground-truth data to verify/fix
// the assumed channel-block layout (see m32-manager.js /meters/2 handler).
function logMeterBlobOnce(label, blob) {
  if (!blob || blob.length < 8) { console.log(`[M32][meter-debug] ${label}: blob too short (${blob?.length ?? 0}B)`); return; }
  const countLE  = blob.readInt32LE(0);
  const expected = countLE * 4;
  const offset   = (expected > 0 && expected <= blob.length - 4) ? 4 : 0;
  const maxFloats = Math.floor((blob.length - offset) / 4);
  const floats = [];
  for (let i = 0; i < maxFloats; i++) {
    const lo = offset + i * 4;
    if (lo + 4 > blob.length) break;
    const v = blob.readFloatLE(lo);
    floats.push(`[${i}] ${v.toFixed(6)} (${linToDbFS(v).toFixed(1)}dB)`);
  }
  console.log(`[M32][meter-debug] ${label}: blobLen=${blob.length}B countHeader=${countLE} offset=${offset} floats(${floats.length})=\n  ${floats.join('\n  ')}`);
}

// ── M32Manager ───────────────────────────────────────────────

class M32Manager extends EventEmitter {
  constructor() {
    super();
    this._sock    = null;
    this._ip      = null;
    this._xTimer  = null;
    this._mTimer  = null;
    this.status   = 'disconnected';

    // Cached state (sent to newly connected clients)
    this.channelNames    = {};   // '01'..'32' → string
    this.busNames        = {};   // '01'..'16' → string
    this.busConfig       = {};   // '01'..'16' → { mono: bool }
    this.sendLevels      = {};   // 'ch:bus'   → { level, on }
    this.channelOn       = {};   // '01'..'32' → bool (channel master mute, /ch/NN/mix/on)
    this.dcaNames        = {};   // '01'..'08' → string
    this.dcaOn           = {};   // '01'..'08' → bool (DCA group mute state, /dca/N/on — 1=active, 0=muted)
    this.busLevels       = {};   // '01'..'16' → { level, on }
    this.auxInNames      = {};   // '01'..'08' → string
    this.fxRtnNames      = {};   // '01'..'04' → string
    this.auxInOn         = {};   // '01'..'08' → bool (channel master mute, /auxin/NN/mix/on)
    this.fxRtnOn         = {};   // '01'..'04' → bool (channel master mute, /fxrtn/NN/mix/on)

    // One-shot raw meter-blob dump per connection — temporary diagnostic to
    // verify the assumed /meters/2 layout (8 AuxIn + 4 FxRtn) against what the
    // device actually sends (see live-test report: AuxIn shows phantom signal,
    // FxRtn 3/4 missing signal — current mapping may be wrong).
    this._meterBlobLogged = new Set();
    this.auxInSendLevels = {};   // 'ch:bus'   → { level, on }
    this.fxRtnSendLevels = {};   // 'ch:bus'   → { level, on }
  }

  connect(ip) {
    if (this._sock) this._cleanup();
    this._ip = ip;
    this._meterBlobLogged.clear();
    this._setStatus('connecting');

    const sock = dgram.createSocket('udp4');
    this._sock = sock;

    sock.on('error', (err) => {
      console.error('[M32] UDP error:', err.message);
      this._setStatus('error', err.message);
    });

    sock.on('message', (msg) => this._handleMsg(msg));

    sock.bind(0, () => {
      console.log(`[M32] Bound → ${ip}:${M32_PORT}`);
      this._xremote();
      this._xTimer = setInterval(() => this._xremote(), XREMOTE_INTERVAL);
      this._queryNames();
      this._mTimer = setInterval(() => this._pollMeters(), METER_INTERVAL);
    });
  }

  disconnect() {
    this._cleanup();
    this._setStatus('disconnected');
    console.log('[M32] Disconnected');
  }

  _cleanup() {
    if (this._xTimer) { clearInterval(this._xTimer);  this._xTimer = null; }
    if (this._mTimer) { clearInterval(this._mTimer);  this._mTimer = null; }
    if (this._queryTimers) { this._queryTimers.forEach(t => clearTimeout(t)); this._queryTimers = null; }
    if (this._sock)   { try { this._sock.close(); } catch (_) {} this._sock = null; }
  }

  _setStatus(status, error) {
    this.status = status;
    this.emit('status', { status, ip: this._ip, error });
  }

  _send(address, args = []) {
    if (!this._sock || !this._ip) return;
    const buf = oscEncode(address, args);
    this._sock.send(buf, M32_PORT, this._ip);
  }

  _xremote()       { this._send('/xremote'); }
  _pollMeters()    {
    this._send('/meters', [{ type: 's', value: '/meters/1' }]);
    this._send('/meters', [{ type: 's', value: '/meters/2' }]);
    this._send('/meters', [{ type: 's', value: '/meters/5' }]);
  }

  _queryNames() {
    // Stagger queries — M32 drops responses when flooded with 160+ packets at once.
    // Delay 150ms after /xremote so M32 registers subscription first.
    this._queryTimers = [];
    const sched = (fn, ms) => this._queryTimers.push(setTimeout(fn, ms));

    sched(() => {
      for (let i = 1; i <= 8; i++) {
        const ch = String(i).padStart(2, '0');
        this._send(`/ch/${ch}/config/name`);
        this._send(`/ch/${ch}/mix/on`);
      }
    }, 150);
    sched(() => {
      for (let i = 9; i <= 16; i++) {
        const ch = String(i).padStart(2, '0');
        this._send(`/ch/${ch}/config/name`);
        this._send(`/ch/${ch}/mix/on`);
      }
    }, 300);
    sched(() => {
      for (let i = 17; i <= 24; i++) {
        const ch = String(i).padStart(2, '0');
        this._send(`/ch/${ch}/config/name`);
        this._send(`/ch/${ch}/mix/on`);
      }
    }, 450);
    sched(() => {
      for (let i = 25; i <= 32; i++) {
        const ch = String(i).padStart(2, '0');
        this._send(`/ch/${ch}/config/name`);
        this._send(`/ch/${ch}/mix/on`);
      }
    }, 600);
    sched(() => {
      for (let i = 1; i <= 8; i++) {
        const ch = String(i).padStart(2, '0');
        this._send(`/auxin/${ch}/config/name`);
        this._send(`/auxin/${ch}/mix/on`);
      }
      for (let i = 1; i <= 4; i++) {
        const osc = fxLogicalToOsc(i);
        this._send(`/fxrtn/${osc}/config/name`);
        this._send(`/fxrtn/${osc}/mix/on`);
      }
    }, 750);
    sched(() => {
      for (let i = 1; i <= 8; i++) {
        this._send(`/dca/${i}/config/name`);
        this._send(`/dca/${i}/on`);
      }
    }, 900);
    sched(() => {
      for (let i = 1; i <= 16; i++) {
        const b = String(i).padStart(2, '0');
        this._send(`/bus/${b}/config/name`);
        this._send(`/bus/${b}/config/ms`);
        this._send(`/bus/${b}/mix/level`);
        this._send(`/bus/${b}/mix/on`);
      }
    }, 1100);
    // Re-query all names after 3s — catches any responses M32 dropped in first pass
    sched(() => this._retryQueryNames(), 3000);
  }

  _retryQueryNames() {
    for (let i = 1; i <= 32; i++) {
      const ch = String(i).padStart(2, '0');
      this._send(`/ch/${ch}/config/name`);
      this._send(`/ch/${ch}/mix/on`);
    }
    setTimeout(() => {
      for (let i = 1; i <= 8; i++) {
        const ch = String(i).padStart(2, '0');
        this._send(`/auxin/${ch}/config/name`);
        this._send(`/auxin/${ch}/mix/on`);
      }
      for (let i = 1; i <= 4; i++) {
        const osc = fxLogicalToOsc(i);
        this._send(`/fxrtn/${osc}/config/name`);
        this._send(`/fxrtn/${osc}/mix/on`);
      }
      for (let i = 1; i <= 8; i++) {
        this._send(`/dca/${i}/config/name`);
        this._send(`/dca/${i}/on`);
      }
      for (let i = 1; i <= 16; i++) {
        const b = String(i).padStart(2, '0');
        this._send(`/bus/${b}/config/name`);
        this._send(`/bus/${b}/config/ms`);
      }
    }, 200);
  }

  queryBus(busNum) {
    const bus = String(busNum).padStart(2, '0');
    this._send(`/bus/${bus}/mix/level`);
    this._send(`/bus/${bus}/mix/on`);
    for (let i = 1; i <= 32; i++) {
      const ch = String(i).padStart(2, '0');
      this._send(`/ch/${ch}/mix/${bus}/level`);
      this._send(`/ch/${ch}/mix/${bus}/on`);
    }
    for (let i = 1; i <= 8; i++) {
      const ch = String(i).padStart(2, '0');
      this._send(`/auxin/${ch}/mix/${bus}/level`);
      this._send(`/auxin/${ch}/mix/${bus}/on`);
    }
    for (let i = 1; i <= 4; i++) {
      const osc = fxLogicalToOsc(i);
      this._send(`/fxrtn/${osc}/mix/${bus}/level`);
      this._send(`/fxrtn/${osc}/mix/${bus}/on`);
    }
  }

  // ── Incoming message handler ──────────────────────────────

  _handleMsg(raw) {
    const msg = oscDecode(raw);
    if (!msg) return;

    if (this.status === 'connecting') this._setStatus('connected');

    const { address, args } = msg;
    const a0 = args[0];

    // Channel name
    const mChName = address.match(/^\/ch\/(\d+)\/config\/name$/);
    if (mChName) {
      const ch = mChName[1];
      this.channelNames[ch] = (a0?.value || '').trim() || `CH ${parseInt(ch)}`;
      this.emit('channelNames', { ...this.channelNames });
      return;
    }

    // Channel master mute  /ch/NN/mix/on  (0=muted, 1=on) — distinct from /ch/NN/mix/MM/on (per-bus send)
    const mChOn = address.match(/^\/ch\/(\d+)\/mix\/on$/);
    if (mChOn) {
      const ch = mChOn[1];
      this.channelOn[ch] = a0?.value === 1;
      this.emit('channelOn', { ch, on: this.channelOn[ch] });
      return;
    }

    // DCA group name  /dca/N/config/name
    const mDcaName = address.match(/^\/dca\/(\d+)\/config\/name$/);
    if (mDcaName) {
      const dca = String(parseInt(mDcaName[1])).padStart(2, '0');
      this.dcaNames[dca] = (a0?.value || '').trim() || `DCA ${parseInt(dca)}`;
      this.emit('dcaNames', { ...this.dcaNames });
      return;
    }

    // DCA group mute  /dca/N/on  (1=active, 0=muted)
    const mDcaOn = address.match(/^\/dca\/(\d+)\/on$/);
    if (mDcaOn) {
      const dca = String(parseInt(mDcaOn[1])).padStart(2, '0');
      this.dcaOn[dca] = a0?.value === 1;
      this.emit('dcaOn', { dca, on: this.dcaOn[dca] });
      return;
    }

    // Bus name
    const mBusName = address.match(/^\/bus\/(\d+)\/config\/name$/);
    if (mBusName) {
      const bus = mBusName[1];
      this.busNames[bus] = (a0?.value || '').trim() || `Bus ${parseInt(bus)}`;
      this.emit('busNames', { ...this.busNames });
      return;
    }

    // Bus mono/stereo  — ms: 0=ST (linked stereo), 1=MS, 2=M (mono)
    const mMs = address.match(/^\/bus\/(\d+)\/config\/ms$/);
    if (mMs) {
      const bus = String(parseInt(mMs[1])).padStart(2, '0');
      if (!this.busConfig[bus]) this.busConfig[bus] = { mono: false };
      const msVal = Math.round(a0?.value ?? 1);
      this.busConfig[bus].mono = msVal !== 0; // only ST (0) = linked stereo
      this.emit('busConfig', { ...this.busConfig });
      return;
    }

    // AuxIn name  /auxin/NN/config/name
    const mAuxName = address.match(/^\/auxin\/(\d+)\/config\/name$/);
    if (mAuxName) {
      const ch = mAuxName[1];
      this.auxInNames[ch] = (a0?.value || '').trim() || `AuxIn ${parseInt(ch)}`;
      this.emit('auxInNames', { ...this.auxInNames });
      return;
    }

    // FxRtn name  /fxrtn/NN/config/name — map OSC pair to logical ch 01-04
    const mFxName = address.match(/^\/fxrtn\/(\d+)\/config\/name$/);
    if (mFxName) {
      const logCh = fxOscToLogical(mFxName[1]);
      const raw = (a0?.value || '').trim();
      const def = FXRTN_DEFAULT[parseInt(logCh) - 1] ?? `FxRtn ${parseInt(logCh)}`;
      this.fxRtnNames[logCh] = raw || def;
      this.emit('fxRtnNames', { ...this.fxRtnNames });
      return;
    }

    // AuxIn master mute  /auxin/NN/mix/on  (0=muted, 1=on) — distinct from /auxin/NN/mix/MM/on (per-bus send)
    const mAuxOn = address.match(/^\/auxin\/(\d+)\/mix\/on$/);
    if (mAuxOn) {
      const ch = mAuxOn[1];
      this.auxInOn[ch] = a0?.value === 1;
      this.emit('auxInOn', { ch, on: this.auxInOn[ch] });
      return;
    }

    // FxRtn master mute  /fxrtn/NN/mix/on — pair leaders only (odd OSC ch)
    const mFxOn = address.match(/^\/fxrtn\/(\d+)\/mix\/on$/);
    if (mFxOn) {
      if (parseInt(mFxOn[1]) % 2 === 0) return;
      const ch = fxOscToLogical(mFxOn[1]);
      this.fxRtnOn[ch] = a0?.value === 1;
      this.emit('fxRtnOn', { ch, on: this.fxRtnOn[ch] });
      return;
    }

    // AuxIn send level  /auxin/NN/mix/MM/level
    const mAuxSendLvl = address.match(/^\/auxin\/(\d+)\/mix\/(\d+)\/level$/);
    if (mAuxSendLvl) {
      const [,ch,bus] = mAuxSendLvl;
      const key = `${ch}:${bus}`;
      if (!this.auxInSendLevels[key]) this.auxInSendLevels[key] = { level: 0.75, on: true };
      this.auxInSendLevels[key].level = a0?.value ?? 0.75;
      this.emit('auxInSendLevel', { ch, bus, ...this.auxInSendLevels[key] });
      return;
    }

    // AuxIn send on  /auxin/NN/mix/MM/on
    const mAuxSendOn = address.match(/^\/auxin\/(\d+)\/mix\/(\d+)\/on$/);
    if (mAuxSendOn) {
      const [,ch,bus] = mAuxSendOn;
      const key = `${ch}:${bus}`;
      if (!this.auxInSendLevels[key]) this.auxInSendLevels[key] = { level: 0.75, on: true };
      this.auxInSendLevels[key].on = a0?.value === 1;
      this.emit('auxInSendOn', { ch, bus, ...this.auxInSendLevels[key] });
      return;
    }

    // FxRtn send level  /fxrtn/NN/mix/MM/level — map OSC pair to logical ch 01-04
    const mFxSendLvl = address.match(/^\/fxrtn\/(\d+)\/mix\/(\d+)\/level$/);
    if (mFxSendLvl) {
      const ch = fxOscToLogical(mFxSendLvl[1]);
      const bus = mFxSendLvl[2];
      const key = `${ch}:${bus}`;
      if (!this.fxRtnSendLevels[key]) this.fxRtnSendLevels[key] = { level: 0.75, on: true };
      this.fxRtnSendLevels[key].level = a0?.value ?? 0.75;
      this.emit('fxRtnSendLevel', { ch, bus, ...this.fxRtnSendLevels[key] });
      return;
    }

    // FxRtn send on  /fxrtn/NN/mix/MM/on — map OSC pair to logical ch 01-04
    const mFxSendOn = address.match(/^\/fxrtn\/(\d+)\/mix\/(\d+)\/on$/);
    if (mFxSendOn) {
      const ch = fxOscToLogical(mFxSendOn[1]);
      const bus = mFxSendOn[2];
      const key = `${ch}:${bus}`;
      if (!this.fxRtnSendLevels[key]) this.fxRtnSendLevels[key] = { level: 0.75, on: true };
      this.fxRtnSendLevels[key].on = a0?.value === 1;
      this.emit('fxRtnSendOn', { ch, bus, ...this.fxRtnSendLevels[key] });
      return;
    }

    // Channel send level  /ch/NN/mix/MM/level
    const mSendLvl = address.match(/^\/ch\/(\d+)\/mix\/(\d+)\/level$/);
    if (mSendLvl) {
      const [,ch,bus] = mSendLvl;
      const key = `${ch}:${bus}`;
      if (!this.sendLevels[key]) this.sendLevels[key] = { level: 0.75, on: true };
      this.sendLevels[key].level = a0?.value ?? 0.75;
      this.emit('sendLevel', { ch, bus, ...this.sendLevels[key] });
      return;
    }

    // Channel send on/off  /ch/NN/mix/MM/on
    const mSendOn = address.match(/^\/ch\/(\d+)\/mix\/(\d+)\/on$/);
    if (mSendOn) {
      const [,ch,bus] = mSendOn;
      const key = `${ch}:${bus}`;
      if (!this.sendLevels[key]) this.sendLevels[key] = { level: 0.75, on: true };
      this.sendLevels[key].on = a0?.value === 1;
      this.emit('sendOn', { ch, bus, ...this.sendLevels[key] });
      return;
    }

    // Bus master level  /bus/NN/mix/level
    const mBusLvl = address.match(/^\/bus\/(\d+)\/mix\/level$/);
    if (mBusLvl) {
      const bus = mBusLvl[1];
      if (!this.busLevels[bus]) this.busLevels[bus] = { level: 0.75, on: true };
      this.busLevels[bus].level = a0?.value ?? 0.75;
      this.emit('busLevel', { bus, ...this.busLevels[bus] });
      return;
    }

    // Bus master on/off  /bus/NN/mix/on
    const mBusOn = address.match(/^\/bus\/(\d+)\/mix\/on$/);
    if (mBusOn) {
      const bus = mBusOn[1];
      if (!this.busLevels[bus]) this.busLevels[bus] = { level: 0.75, on: true };
      this.busLevels[bus].on = a0?.value === 1;
      this.emit('busOn', { bus, ...this.busLevels[bus] });
      return;
    }

    // Input meters  /meters/1
    if (address === '/meters/1' && a0?.type === 'blob') {
      if (!this._meterBlobLogged.has('/meters/1')) {
        this._meterBlobLogged.add('/meters/1');
        logMeterBlobOnce('/meters/1 (assumed: 32 input channels)', a0.value);
      }
      const m = parseMeterBlob(a0.value, 32);
      if (m) this.emit('inputMeters', m);
      return;
    }

    // /meters/2 structure (VERIFIED from capture with Plate+Hall active):
    //   float[0-7]  = FX Send bus levels (signal going INTO each FX engine, 2 floats/FX stereo)
    //                 — NOT AuxIn input meters (these go silent when FX is inactive)
    //   float[8-15] = FxRtn 1-4 stereo L+R output (signal coming OUT of each FX engine)
    //                   FX1L=[8], FX1R=[9], FX2L=[10], FX2R=[11],
    //                   FX3L=[12], FX3R=[13], FX4L=[14], FX4R=[15]
    //   float[16-23]= unknown stereo pairs (possibly bus/aux output levels)
    //   float[24]   = separator (-64dB)
    //   float[25-48]= bus fader positions (~0dB)
    if (address === '/meters/2' && a0?.type === 'blob') {
      if (!this._meterBlobLogged.has('/meters/2')) {
        this._meterBlobLogged.add('/meters/2');
        logMeterBlobOnce('/meters/2 (FxRtn1-4 mono at [8-11]; [0-7]=FX sends)', a0.value);
      }
      const blob = a0.value;
      if (!blob || blob.length < 8) return;
      const countLE = blob.readInt32LE(0);
      const expected = countLE * 4;
      const offset = (expected > 0 && expected <= blob.length - 4) ? 4 : 0;

      // FxRtn 1-4: stereo L+R pairs starting at float[8]
      // Layout: FX1L=[8],FX1R=[9], FX2L=[10],FX2R=[11], FX3L=[12],FX3R=[13], FX4L=[14],FX4R=[15]
      const fxRtn = {};
      for (let i = 0; i < 4; i++) {
        const loL = offset + (8 + i * 2) * 4;
        const loR = offset + (8 + i * 2 + 1) * 4;
        if (loR + 4 > blob.length) break;
        const db = linToDbFS(Math.max(blob.readFloatLE(loL), blob.readFloatLE(loR)));
        fxRtn[String(i + 1).padStart(2, '0')] = { left: db, right: db };
      }

      if (Object.keys(fxRtn).length) this.emit('fxRtnMeters', fxRtn);
      return;
    }

    // /meters/3 is GEQ/dynamics data on M32R, NOT AuxIn — produces phantom signal.
    // AuxIn input meters are not available from any M32 meter subscription.

    // Bus meters  /meters/5
    if (address === '/meters/5' && a0?.type === 'blob') {
      const m = parseMeterBlob(a0.value, 16);
      if (m) this.emit('busMeters', m);
      return;
    }
  }

  // ── Control API ───────────────────────────────────────────

  setChannelSendLevel(ch, bus, level) {
    const clamped = Math.min(1, Math.max(0, level));
    this._send(`/ch/${ch}/mix/${bus}/level`, [{ type: 'f', value: clamped }]);
    const key = `${ch}:${bus}`;
    if (!this.sendLevels[key]) this.sendLevels[key] = { level: 0.75, on: true };
    this.sendLevels[key].level = clamped;
    this.emit('sendLevel', { ch, bus, ...this.sendLevels[key] });
  }

  setChannelSendOn(ch, bus, on) {
    this._send(`/ch/${ch}/mix/${bus}/on`, [{ type: 'i', value: on ? 1 : 0 }]);
    const key = `${ch}:${bus}`;
    if (!this.sendLevels[key]) this.sendLevels[key] = { level: 0.75, on: true };
    this.sendLevels[key].on = !!on;
    this.emit('sendOn', { ch, bus, ...this.sendLevels[key] });
  }

  setChannelOn(ch, on) {
    this._send(`/ch/${ch}/mix/on`, [{ type: 'i', value: on ? 1 : 0 }]);
    this.channelOn[ch] = !!on;
    this.emit('channelOn', { ch, on: this.channelOn[ch] });
  }

  setBusLevel(bus, level) {
    const clamped = Math.min(1, Math.max(0, level));
    this._send(`/bus/${bus}/mix/level`, [{ type: 'f', value: clamped }]);
    if (!this.busLevels[bus]) this.busLevels[bus] = { level: 0.75, on: true };
    this.busLevels[bus].level = clamped;
    this.emit('busLevel', { bus, ...this.busLevels[bus] });
  }

  setAuxInSendLevel(ch, bus, level) {
    const clamped = Math.min(1, Math.max(0, level));
    this._send(`/auxin/${ch}/mix/${bus}/level`, [{ type: 'f', value: clamped }]);
    const key = `${ch}:${bus}`;
    if (!this.auxInSendLevels[key]) this.auxInSendLevels[key] = { level: 0.75, on: true };
    this.auxInSendLevels[key].level = clamped;
    this.emit('auxInSendLevel', { ch, bus, ...this.auxInSendLevels[key] });
  }

  setAuxInSendOn(ch, bus, on) {
    this._send(`/auxin/${ch}/mix/${bus}/on`, [{ type: 'i', value: on ? 1 : 0 }]);
    const key = `${ch}:${bus}`;
    if (!this.auxInSendLevels[key]) this.auxInSendLevels[key] = { level: 0.75, on: true };
    this.auxInSendLevels[key].on = !!on;
    this.emit('auxInSendOn', { ch, bus, ...this.auxInSendLevels[key] });
  }

  setFxRtnSendLevel(ch, bus, level) {
    const clamped = Math.min(1, Math.max(0, level));
    const osc = fxLogicalToOsc(ch);
    this._send(`/fxrtn/${osc}/mix/${bus}/level`, [{ type: 'f', value: clamped }]);
    const key = `${ch}:${bus}`;
    if (!this.fxRtnSendLevels[key]) this.fxRtnSendLevels[key] = { level: 0.75, on: true };
    this.fxRtnSendLevels[key].level = clamped;
    this.emit('fxRtnSendLevel', { ch, bus, ...this.fxRtnSendLevels[key] });
  }

  setFxRtnSendOn(ch, bus, on) {
    const osc = fxLogicalToOsc(ch);
    this._send(`/fxrtn/${osc}/mix/${bus}/on`, [{ type: 'i', value: on ? 1 : 0 }]);
    const key = `${ch}:${bus}`;
    if (!this.fxRtnSendLevels[key]) this.fxRtnSendLevels[key] = { level: 0.75, on: true };
    this.fxRtnSendLevels[key].on = !!on;
    this.emit('fxRtnSendOn', { ch, bus, ...this.fxRtnSendLevels[key] });
  }

  setBusOn(bus, on) {
    this._send(`/bus/${bus}/mix/on`, [{ type: 'i', value: on ? 1 : 0 }]);
    if (!this.busLevels[bus]) this.busLevels[bus] = { level: 0.75, on: true };
    this.busLevels[bus].on = !!on;
    this.emit('busOn', { bus, ...this.busLevels[bus] });
  }
}

const manager = new M32Manager();
manager.m32ToDb = m32ToDb;
manager.dbToM32 = dbToM32;

module.exports = manager;
