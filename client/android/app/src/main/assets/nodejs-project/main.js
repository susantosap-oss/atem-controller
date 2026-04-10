'use strict';
/**
 * Embedded ATEM + M32 Server — runs directly on Android via nodejs-mobile.
 * ATEM Mini Pro: UDP port 9910 via atem-connection.
 * Midas M32R Live: OSC UDP port 10023 (inline encoder/decoder, no deps).
 * WebView connects here via Socket.IO on localhost:4000.
 */
const http   = require('http');
const dgram  = require('dgram');
const { Server } = require('socket.io');
const { Atem } = require('atem-connection');

// ═══════════════════════════════════════════════════════════════
// SECTION A — Minimal OSC 1.0 encode/decode (no external deps)
// ═══════════════════════════════════════════════════════════════

function oscPadLen(n) { const r = n % 4; return r === 0 ? n : n + (4 - r); }

function oscEncStr(str) {
  const src = Buffer.from(str + '\0', 'utf8');
  const buf = Buffer.alloc(oscPadLen(src.length));
  src.copy(buf); return buf;
}

function oscEncode(address, args) {
  args = args || [];
  const parts = [oscEncStr(address)];
  let typeTag = ','; const argParts = [];
  for (const a of args) {
    if (a.type === 'i') {
      typeTag += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a.value | 0, 0); argParts.push(b);
    } else if (a.type === 'f') {
      typeTag += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a.value, 0); argParts.push(b);
    } else if (a.type === 's') {
      typeTag += 's'; argParts.push(oscEncStr(a.value));
    }
  }
  parts.push(oscEncStr(typeTag)); parts.push(...argParts);
  return Buffer.concat(parts);
}

function oscReadStr(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString('utf8', off, end);
  return { value, next: off + oscPadLen(end - off + 1) };
}

function oscDecode(buf) {
  try {
    let off = 0;
    const addrR = oscReadStr(buf, off); if (!addrR.value.startsWith('/')) return null;
    off = addrR.next;
    if (off >= buf.length) return { address: addrR.value, args: [] };
    const tagR = oscReadStr(buf, off); off = tagR.next;
    const types = tagR.value.startsWith(',') ? tagR.value.slice(1) : tagR.value;
    const args = [];
    for (const t of types) {
      if (off >= buf.length) break;
      if (t === 'f') { args.push({ type: 'float', value: buf.readFloatBE(off) }); off += 4; }
      else if (t === 'i') { args.push({ type: 'int', value: buf.readInt32BE(off) }); off += 4; }
      else if (t === 's') { const sr = oscReadStr(buf, off); args.push({ type: 'string', value: sr.value }); off = sr.next; }
      else if (t === 'b') {
        const blen = buf.readInt32BE(off); off += 4;
        const blob = Buffer.from(buf.slice(off, off + blen));
        args.push({ type: 'blob', value: blob }); off += oscPadLen(blen);
      }
    }
    return { address: addrR.value, args };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// SECTION B — Midas M32R Live OSC manager
// ═══════════════════════════════════════════════════════════════

const M32_PORT         = 10023;
const M32_XREMOTE_MS   = 9000;
const M32_METER_MS     = 80;

let m32Sock      = null;
let m32IP        = null;
let m32Status    = 'disconnected';
let m32XTimer    = null;
let m32MTimer    = null;

// Cached state
const m32ChNames  = {};   // '01'..'32' → string
const m32BusNames = {};   // '01'..'16' → string
const m32BusCfg   = {};   // '01'..'16' → { mono }
const m32Sends    = {};   // 'ch:bus'   → { level, on }
const m32BusLvl   = {};   // '01'..'16' → { level, on }

function m32SetStatus(s, error) {
  m32Status = s;
  io.emit('m32:status', { status: s, ip: m32IP, error });
}

function m32Send(address, args) {
  if (!m32Sock || !m32IP) return;
  const buf = oscEncode(address, args);
  m32Sock.send(buf, M32_PORT, m32IP);
}

function m32Connect(ip) {
  m32Cleanup();
  m32IP = ip;
  m32SetStatus('connecting');
  const sock = dgram.createSocket('udp4');
  m32Sock = sock;
  sock.on('error', (err) => { console.error('[M32] Error:', err.message); m32SetStatus('error', err.message); });
  sock.on('message', (msg) => m32HandleMsg(msg));
  sock.bind(0, () => {
    console.log('[M32] Bound →', ip + ':' + M32_PORT);
    m32Xremote();
    m32XTimer = setInterval(m32Xremote, M32_XREMOTE_MS);
    m32QueryAll();
    m32MTimer = setInterval(m32PollMeters, M32_METER_MS);
  });
}

function m32Disconnect() {
  m32Cleanup();
  m32SetStatus('disconnected');
}

function m32Cleanup() {
  if (m32XTimer) { clearInterval(m32XTimer); m32XTimer = null; }
  if (m32MTimer) { clearInterval(m32MTimer); m32MTimer = null; }
  if (m32Sock)   { try { m32Sock.close(); } catch (_) {} m32Sock = null; }
}

function m32Xremote()    { m32Send('/xremote'); }
function m32PollMeters() {
  m32Send('/meters', [{ type: 's', value: '/meters/1' }]);
  m32Send('/meters', [{ type: 's', value: '/meters/5' }]);
}

function m32QueryAll() {
  for (let i = 1; i <= 32; i++) {
    const ch = String(i).padStart(2, '0');
    m32Send('/ch/' + ch + '/config/name');
  }
  for (let i = 1; i <= 16; i++) {
    const b = String(i).padStart(2, '0');
    m32Send('/bus/' + b + '/config/name');
    m32Send('/bus/' + b + '/config/ms');
    m32Send('/bus/' + b + '/mix/level');
    m32Send('/bus/' + b + '/mix/on');
  }
}

function m32QueryBus(busNum) {
  const bus = String(busNum).padStart(2, '0');
  m32Send('/bus/' + bus + '/mix/level');
  m32Send('/bus/' + bus + '/mix/on');
  for (let i = 1; i <= 32; i++) {
    const ch = String(i).padStart(2, '0');
    m32Send('/ch/' + ch + '/mix/' + bus + '/level');
    m32Send('/ch/' + ch + '/mix/' + bus + '/on');
  }
}

function parseMeterBlob(blob, numCh) {
  if (!blob || blob.length < 8) return null;
  try {
    const countLE = blob.readInt32LE(0);
    const expected = countLE * 4;
    const offset = (expected > 0 && expected <= blob.length - 4) ? 4 : 0;
    const result = {};
    for (let i = 0; i < numCh; i++) {
      const lo = offset + i * 8, ro = lo + 4;
      if (ro + 4 > blob.length) break;
      const vl = blob.readFloatLE(lo), vr = blob.readFloatLE(ro);
      const ch = String(i + 1).padStart(2, '0');
      const toDb = v => v <= 0 ? -90 : Math.max(-90, Math.round(20 * Math.log10(v) * 10) / 10);
      result[ch] = { left: toDb(vl), right: toDb(vr) };
    }
    return Object.keys(result).length ? result : null;
  } catch (_) { return null; }
}

function m32HandleMsg(raw) {
  const msg = oscDecode(raw);
  if (!msg) return;
  if (m32Status === 'connecting') m32SetStatus('connected');
  const { address, args } = msg;
  const a0 = args[0];

  let m;
  if ((m = address.match(/^\/ch\/(\d+)\/config\/name$/))) {
    m32ChNames[m[1]] = (a0 && a0.value || '').trim() || ('CH ' + parseInt(m[1]));
    io.emit('m32:channelNames', Object.assign({}, m32ChNames)); return;
  }
  if ((m = address.match(/^\/bus\/(\d+)\/config\/name$/))) {
    m32BusNames[m[1]] = (a0 && a0.value || '').trim() || ('Bus ' + parseInt(m[1]));
    io.emit('m32:busNames', Object.assign({}, m32BusNames)); return;
  }
  if ((m = address.match(/^\/bus\/(\d+)\/config\/ms$/))) {
    m32BusCfg[m[1]] = { mono: a0 && a0.value === 1 };
    io.emit('m32:busConfig', Object.assign({}, m32BusCfg)); return;
  }
  if ((m = address.match(/^\/ch\/(\d+)\/mix\/(\d+)\/level$/))) {
    const key = m[1] + ':' + m[2];
    if (!m32Sends[key]) m32Sends[key] = { level: 0.75, on: true };
    m32Sends[key].level = (a0 && a0.value != null) ? a0.value : 0.75;
    io.emit('m32:sendLevel', { ch: m[1], bus: m[2], level: m32Sends[key].level, on: m32Sends[key].on }); return;
  }
  if ((m = address.match(/^\/ch\/(\d+)\/mix\/(\d+)\/on$/))) {
    const key = m[1] + ':' + m[2];
    if (!m32Sends[key]) m32Sends[key] = { level: 0.75, on: true };
    m32Sends[key].on = a0 && a0.value === 1;
    io.emit('m32:sendOn', { ch: m[1], bus: m[2], level: m32Sends[key].level, on: m32Sends[key].on }); return;
  }
  if ((m = address.match(/^\/bus\/(\d+)\/mix\/level$/))) {
    if (!m32BusLvl[m[1]]) m32BusLvl[m[1]] = { level: 0.75, on: true };
    m32BusLvl[m[1]].level = (a0 && a0.value != null) ? a0.value : 0.75;
    io.emit('m32:busLevel', { bus: m[1], level: m32BusLvl[m[1]].level, on: m32BusLvl[m[1]].on }); return;
  }
  if ((m = address.match(/^\/bus\/(\d+)\/mix\/on$/))) {
    if (!m32BusLvl[m[1]]) m32BusLvl[m[1]] = { level: 0.75, on: true };
    m32BusLvl[m[1]].on = a0 && a0.value === 1;
    io.emit('m32:busOn', { bus: m[1], level: m32BusLvl[m[1]].level, on: m32BusLvl[m[1]].on }); return;
  }
  if (address === '/meters/1' && a0 && a0.type === 'blob') {
    const mt = parseMeterBlob(a0.value, 32);
    if (mt) io.emit('m32:inputMeters', mt); return;
  }
  if (address === '/meters/5' && a0 && a0.type === 'blob') {
    const mt = parseMeterBlob(a0.value, 16);
    if (mt) io.emit('m32:busMeters', mt); return;
  }
}

const PORT = 4000;
const VU_THROTTLE_MS = 33;       // ~30fps
const VU_DELTA_THRESHOLD = 0.5;  // dB

// ── ATEM state ────────────────────────────────────────────────
let atem = null;
let atemStatus = 'disconnected';
let atemIP = null;
let atemState = null;
let reconnectTimer = null;

// ── VU throttle state ─────────────────────────────────────────
let pendingVu = null;
let vuTimer = null;
let lastVuSnapshot = {};
let lastVuEmit = 0;

// ── Socket.IO server ──────────────────────────────────────────
const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ── ATEM helpers ──────────────────────────────────────────────

function setStatus(status, message = '') {
  atemStatus = status;
  console.log(`[ATEM] Status: ${status}${message ? ' — ' + message : ''}`);
  io.emit('atem:status', { status, message, ip: atemIP });
}

function connectAtem(ip) {
  if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    setStatus('error', 'Invalid IP: ' + ip);
    return;
  }
  if (atem) {
    clearTimeout(reconnectTimer);
    atem.removeAllListeners();
    atem.disconnect().catch(() => {});
    atem = null;
  }

  atemIP = ip;
  setStatus('connecting');
  atem = new Atem();

  atem.on('connected', () => {
    clearTimeout(reconnectTimer);
    atemState = atem.state;
    setStatus('connected');
    const audioState = buildAudioState();
    if (audioState) io.emit('atem:audioState', audioState);
    const mediaState = buildMediaState();
    if (mediaState) io.emit('atem:mediaState', mediaState);
    const videoState = buildVideoState();
    if (videoState) io.emit('atem:videoState', videoState);
  });

  atem.on('disconnected', () => {
    setStatus('disconnected');
    reconnectTimer = setTimeout(() => {
      if (atemStatus !== 'connected' && atemIP) connectAtem(atemIP);
    }, 5000);
  });

  atem.on('stateChanged', (state, pathKeys) => {
    atemState = state;
    handleStateChange(pathKeys);
  });

  atem.on('error', (err) => {
    console.error('[ATEM] Error:', err.message);
    setStatus('error', err.message);
  });

  reconnectTimer = setTimeout(() => {
    if (atemStatus !== 'connected') setStatus('error', 'Connection timeout');
  }, 10000);

  atem.connect(ip).catch(err => setStatus('error', err.message));
}

function disconnectAtem() {
  clearTimeout(reconnectTimer);
  if (atem) {
    atem.removeAllListeners();
    atem.disconnect().catch(() => {});
    atem = null;
  }
  atemIP = null;
  atemState = null;
  setStatus('disconnected');
}

// ── State change dispatcher ───────────────────────────────────

function handleStateChange(pathKeys) {
  if (!pathKeys || !pathKeys.length) return;

  const audioStatePaths = pathKeys.filter(
    k => (k.startsWith('audio') && !k.includes('levels')) || k.startsWith('settings.inputs')
  );
  if (audioStatePaths.length > 0) {
    const s = buildAudioState();
    if (s) io.emit('atem:audioState', s);
  }

  const mediaStatePaths = pathKeys.filter(k => k.startsWith('media'));
  if (mediaStatePaths.length > 0) {
    const s = buildMediaState();
    if (s) io.emit('atem:mediaState', s);
  }

  const videoStatePaths = pathKeys.filter(k => k.startsWith('video'));
  if (videoStatePaths.length > 0) {
    const s = buildVideoState();
    if (s) io.emit('atem:videoState', s);
  }

  const hasLevels = pathKeys.some(k => k.includes('levels') || k.includes('Level'));
  if (hasLevels && atemState && atemState.audio) {
    const levels = buildLevels();
    if (levels) {
      pendingVu = levels;
      scheduleVuFlush();
    }
  }
}

// ── VU throttle ───────────────────────────────────────────────

function scheduleVuFlush() {
  if (vuTimer) return;
  const now = Date.now();
  const delay = Math.max(0, VU_THROTTLE_MS - (now - lastVuEmit));
  vuTimer = setTimeout(flushVu, delay);
}

function flushVu() {
  vuTimer = null;
  if (!pendingVu) return;
  const filtered = filterVuDelta(pendingVu);
  if (filtered) {
    io.emit('atem:vuMeter', filtered);
    Object.assign(lastVuSnapshot, filtered);
  }
  lastVuEmit = Date.now();
  pendingVu = null;
}

function filterVuDelta(levels) {
  const out = {};
  let hasChange = false;
  for (const [ch, val] of Object.entries(levels)) {
    const prev = lastVuSnapshot[ch];
    if (!prev ||
      Math.abs(val.left - prev.left) > VU_DELTA_THRESHOLD ||
      Math.abs(val.right - prev.right) > VU_DELTA_THRESHOLD) {
      out[ch] = val;
      hasChange = true;
    }
  }
  return hasChange ? out : null;
}

// ── State builders ────────────────────────────────────────────

function getChannelLabel(idx) {
  const shortName = atemState && atemState.settings && atemState.settings.inputs &&
    atemState.settings.inputs[idx] && atemState.settings.inputs[idx].shortName &&
    atemState.settings.inputs[idx].shortName.trim();
  if (shortName) return shortName;
  const labels = {
    1: 'HDMI 1', 2: 'HDMI 2', 3: 'HDMI 3', 4: 'HDMI 4',
    5: 'HDMI 5', 6: 'HDMI 6', 7: 'HDMI 7', 8: 'HDMI 8',
    1301: 'MIC 1', 1302: 'MIC 2', 2001: 'XLR 1', 2002: 'XLR 2',
  };
  return labels[idx] || `CH ${idx}`;
}

function buildAudioState() {
  if (!atemState || !atemState.audio) return null;
  const audio = atemState.audio;
  const channels = {};
  if (audio.channels) {
    for (const [idx, ch] of Object.entries(audio.channels)) {
      channels[idx] = {
        gain: ch.gain != null ? ch.gain : 0,
        balance: ch.balance != null ? ch.balance : 0,
        mixOption: ch.mixOption != null ? ch.mixOption : 0,
        label: getChannelLabel(Number(idx)),
      };
    }
  }
  const master = audio.master
    ? { gain: audio.master.gain != null ? audio.master.gain : 0, balance: audio.master.balance != null ? audio.master.balance : 0, followFadeToBlack: audio.master.followFadeToBlack || false }
    : { gain: 0, balance: 0, followFadeToBlack: false };
  return { channels, master };
}

function buildLevels() {
  if (!atemState || !atemState.audio || !atemState.audio.levels) return null;
  const result = {};
  if (atemState.audio.levels.channels) {
    for (const [idx, ch] of Object.entries(atemState.audio.levels.channels)) {
      result[idx] = { left: ch.left != null ? ch.left : -60, right: ch.right != null ? ch.right : -60, peakLeft: ch.peakLeft != null ? ch.peakLeft : -60, peakRight: ch.peakRight != null ? ch.peakRight : -60 };
    }
  }
  if (atemState.audio.levels.master) {
    const m = atemState.audio.levels.master;
    result.master = { left: m.left != null ? m.left : -60, right: m.right != null ? m.right : -60, peakLeft: m.peakLeft != null ? m.peakLeft : -60, peakRight: m.peakRight != null ? m.peakRight : -60 };
  }
  return result;
}

function buildMediaState() {
  if (!atemState || !atemState.media) return null;
  const media = atemState.media;
  const players = {};
  if (media.players) {
    for (const [idx, player] of Object.entries(media.players)) {
      players[idx] = { sourceType: player.sourceType != null ? player.sourceType : 1, stillIndex: player.stillIndex != null ? player.stillIndex : 0, playing: player.playing || false, loop: player.loop || false };
    }
  }
  const stillPool = {};
  if (media.stillPool) {
    for (const [idx, still] of Object.entries(media.stillPool)) {
      stillPool[idx] = { isUsed: still.isUsed || false, fileName: still.fileName || '' };
    }
  }
  return { players, stillPool };
}

function buildVideoState() {
  if (!atemState || !atemState.video) return null;
  const me = atemState.video.ME && atemState.video.ME[0];
  if (!me) return null;
  const dsk = [0, 1].map(i => {
    const d = atemState.video.downstreamKeyers && atemState.video.downstreamKeyers[i];
    return { onAir: d && d.onAir || false, inTransition: d && d.inTransition || false, autoRate: d && d.autoRate != null ? d.autoRate : 25, fillSource: d && d.sources && d.sources.fillSource || 0, cutSource: d && d.sources && d.sources.cutSource || 0 };
  });
  const sources = { 1: 'CH 1', 2: 'CH 2', 3: 'CH 3', 4: 'CH 4', 3010: 'MP 1', 3020: 'MP 2', 0: 'BLK' };
  const inputLabels = {};
  for (const [id, fallback] of Object.entries(sources)) {
    const shortName = atemState && atemState.settings && atemState.settings.inputs && atemState.settings.inputs[Number(id)] && atemState.settings.inputs[Number(id)].shortName && atemState.settings.inputs[Number(id)].shortName.trim();
    inputLabels[id] = shortName || fallback;
  }
  return {
    programInput: me.programInput != null ? me.programInput : 0,
    previewInput: me.previewInput != null ? me.previewInput : 0,
    transitionStyle: me.transitionSettings && me.transitionSettings.style != null ? me.transitionSettings.style : 0,
    transitionInProgress: me.transitionInProgress || false,
    transitionPosition: me.transitionPosition != null ? me.transitionPosition : 0,
    fadeToBlack: { isFullyBlack: me.fadeToBlack && me.fadeToBlack.isFullyBlack || false, inTransition: me.fadeToBlack && me.fadeToBlack.inTransition || false },
    dsk,
    inputLabels,
  };
}

// ── ATEM command helpers ──────────────────────────────────────

function isConnected() { return atemStatus === 'connected' && atem !== null; }

// ── Socket.IO connection handler ──────────────────────────────

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Handshake
  socket.emit('server:handshake', {
    atemIP: atemIP || '',
    serverPort: PORT,
    atemStatus: { status: atemStatus, ip: atemIP },
    m32Status:  { status: m32Status,  ip: m32IP  },
  });

  // Send current M32 state
  if (m32Status === 'connected') {
    if (Object.keys(m32ChNames).length)  socket.emit('m32:channelNames', Object.assign({}, m32ChNames));
    if (Object.keys(m32BusNames).length) socket.emit('m32:busNames',     Object.assign({}, m32BusNames));
    if (Object.keys(m32BusCfg).length)   socket.emit('m32:busConfig',    Object.assign({}, m32BusCfg));
    for (const [bus, d] of Object.entries(m32BusLvl))
      socket.emit('m32:busLevel', { bus, level: d.level, on: d.on });
    for (const [key, d] of Object.entries(m32Sends)) {
      const [ch, bus] = key.split(':');
      socket.emit('m32:sendLevel', { ch, bus, level: d.level, on: d.on });
    }
  }

  // Send current state if connected
  if (atemStatus === 'connected') {
    const audioState = buildAudioState();
    if (audioState) socket.emit('atem:audioState', audioState);
    const mediaState = buildMediaState();
    if (mediaState) socket.emit('atem:mediaState', mediaState);
    const videoState = buildVideoState();
    if (videoState) socket.emit('atem:videoState', videoState);
  }

  socket.on('atem:connect', ({ ip }) => connectAtem(ip));
  socket.on('atem:disconnect', () => disconnectAtem());

  socket.on('atem:setGain', ({ index, gain }) => {
    if (isConnected()) atem.setAudioMixerInputProps(index, { gain }).catch(() => {});
  });
  socket.on('atem:setMixOption', ({ index, mixOption }) => {
    if (isConnected()) atem.setAudioMixerInputProps(index, { mixOption }).catch(() => {});
  });
  socket.on('atem:setBalance', ({ index, balance }) => {
    if (isConnected()) atem.setAudioMixerInputProps(index, { balance }).catch(() => {});
  });
  socket.on('atem:setMasterGain', ({ gain }) => {
    if (isConnected()) atem.setAudioMixerMasterProps({ gain }).catch(() => {});
  });
  socket.on('atem:setMasterBalance', ({ balance }) => {
    if (isConnected()) atem.setAudioMixerMasterProps({ balance }).catch(() => {});
  });
  socket.on('atem:setMediaPlayerStill', ({ playerIndex, stillIndex }) => {
    if (isConnected()) atem.setMediaPlayerSource(playerIndex, { sourceType: 1, stillIndex }).catch(() => {});
  });
  socket.on('atem:setPreviewInput', ({ source }) => {
    if (isConnected()) atem.changePreviewInput(0, source).catch(() => {});
  });
  socket.on('atem:setProgramInput', ({ source }) => {
    if (isConnected()) atem.changeProgramInput(0, source).catch(() => {});
  });
  socket.on('atem:performAuto', () => {
    if (isConnected()) atem.autoTransition(0).catch(() => {});
  });
  socket.on('atem:performCut', () => {
    if (isConnected()) atem.cut(0).catch(() => {});
  });
  socket.on('atem:setTransitionStyle', ({ style }) => {
    if (isConnected()) atem.setTransitionStyle(0, { style }).catch(() => {});
  });
  socket.on('atem:setTransitionPosition', ({ position }) => {
    if (isConnected()) atem.setMixEffectTransitionPosition(0, position).catch(() => {});
  });
  socket.on('atem:performFTB', () => {
    if (isConnected()) atem.fadeToBlack(0).catch(() => {});
  });
  socket.on('atem:setDSKOnAir', ({ keyerIndex, onAir }) => {
    if (isConnected()) atem.setDownstreamKeyerOnAir(keyerIndex, onAir).catch(() => {});
  });
  socket.on('atem:autoDSKTransition', ({ keyerIndex }) => {
    if (isConnected()) atem.autoDownstreamKey(keyerIndex).catch(() => {});
  });

  // ── M32 commands ───────────────────────────────────────────
  socket.on('m32:connect',            ({ ip })             => m32Connect(ip));
  socket.on('m32:disconnect',         ()                   => m32Disconnect());
  socket.on('m32:queryBus',           ({ bus })            => m32QueryBus(bus));
  socket.on('m32:setChannelSendLevel',({ ch, bus, level }) => {
    m32Send('/ch/' + ch + '/mix/' + bus + '/level', [{ type: 'f', value: Math.min(1, Math.max(0, level)) }]);
    const key = ch + ':' + bus;
    if (!m32Sends[key]) m32Sends[key] = { level: 0.75, on: true };
    m32Sends[key].level = level;
    io.emit('m32:sendLevel', { ch, bus, level, on: m32Sends[key].on });
  });
  socket.on('m32:setChannelSendOn',   ({ ch, bus, on })   => {
    m32Send('/ch/' + ch + '/mix/' + bus + '/on', [{ type: 'i', value: on ? 1 : 0 }]);
    const key = ch + ':' + bus;
    if (!m32Sends[key]) m32Sends[key] = { level: 0.75, on: true };
    m32Sends[key].on = !!on;
    io.emit('m32:sendOn', { ch, bus, level: m32Sends[key].level, on: !!on });
  });
  socket.on('m32:setBusLevel',        ({ bus, level })     => {
    m32Send('/bus/' + bus + '/mix/level', [{ type: 'f', value: Math.min(1, Math.max(0, level)) }]);
    if (!m32BusLvl[bus]) m32BusLvl[bus] = { level: 0.75, on: true };
    m32BusLvl[bus].level = level;
    io.emit('m32:busLevel', { bus, level, on: m32BusLvl[bus].on });
  });
  socket.on('m32:setBusOn',           ({ bus, on })        => {
    m32Send('/bus/' + bus + '/mix/on', [{ type: 'i', value: on ? 1 : 0 }]);
    if (!m32BusLvl[bus]) m32BusLvl[bus] = { level: 0.75, on: true };
    m32BusLvl[bus].on = !!on;
    io.emit('m32:busOn', { bus, level: m32BusLvl[bus].level, on: !!on });
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ── Start server ──────────────────────────────────────────────

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[ATEM-EMBEDDED] Server ready on localhost:${PORT}`);
});
