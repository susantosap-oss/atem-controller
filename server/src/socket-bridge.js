/**
 * Socket Bridge — Socket.io server that relays ATEM state to PWA clients.
 * Implements VU Meter throttling: batches level updates at 30fps max.
 * Only emits if delta exceeds threshold to reduce bandwidth.
 */
const { createServer } = require('http');
const { Server } = require('socket.io');
const atemManager = require('./atem-manager');
const m32Manager  = require('./m32-manager');
const Config = require('./config');

const VU_THROTTLE_MS = 33;   // ~30fps
const VU_DELTA_THRESHOLD = 0.5; // dB — skip if change < this

let httpServer = null;
let io = null;

// Throttle state
let lastVuEmit = 0;
let pendingVu = null;
let vuTimer = null;
let lastVuSnapshot = {};

function start(port) {
  httpServer = createServer();

  // ── EADDRINUSE guard ──────────────────────────────────────────
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[WS] FATAL: Port ${port} is already in use.`);
      console.error(`[WS] Kill the existing process first, then restart.`);
      console.error(`[WS] Windows: netstat -ano | findstr :${port}  then  taskkill /PID <pid> /F`);
      console.error(`[WS] Linux/Mac: lsof -ti:${port} | xargs kill -9`);
      if (require.main !== module) process.exit(1); // standalone mode: exit
    } else {
      console.error('[WS] Server error:', err);
    }
  });

  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
    pingInterval: 30000,  // kirim ping tiap 30s
    pingTimeout: 60000,   // tunggu pong 60s sebelum dianggap mati — toleransi WiFi Android tidur
  });

  // ── ATEM event → broadcast to all clients ────────────────

  atemManager.on('status', (data) => {
    io.emit('atem:status', data);
  });

  atemManager.on('audioState', (data) => {
    if (data) io.emit('atem:audioState', data);
  });

  atemManager.on('mediaState', (data) => {
    if (data) io.emit('atem:mediaState', data);
  });

  atemManager.on('videoState', (data) => {
    if (data) io.emit('atem:videoState', data);
  });

  atemManager.on('vuMeter', (levels) => {
    pendingVu = levels;
    scheduleVuFlush();
  });

  // ── M32 events → broadcast ─────────────────────────────────
  m32Manager.on('status',           (d) => io.emit('m32:status',           d));
  m32Manager.on('channelNames',     (d) => io.emit('m32:channelNames',     d));
  m32Manager.on('busNames',         (d) => io.emit('m32:busNames',         d));
  m32Manager.on('busConfig',        (d) => io.emit('m32:busConfig',        d));
  m32Manager.on('sendLevel',        (d) => io.emit('m32:sendLevel',        d));
  m32Manager.on('sendOn',           (d) => io.emit('m32:sendOn',           d));
  m32Manager.on('busLevel',         (d) => io.emit('m32:busLevel',         d));
  m32Manager.on('busOn',            (d) => io.emit('m32:busOn',            d));
  m32Manager.on('auxInNames',       (d) => io.emit('m32:auxInNames',       d));
  m32Manager.on('fxRtnNames',       (d) => io.emit('m32:fxRtnNames',       d));
  m32Manager.on('auxInSendLevel',   (d) => io.emit('m32:auxInSendLevel',   d));
  m32Manager.on('auxInSendOn',      (d) => io.emit('m32:auxInSendOn',      d));
  m32Manager.on('fxRtnSendLevel',   (d) => io.emit('m32:fxRtnSendLevel',   d));
  m32Manager.on('fxRtnSendOn',      (d) => io.emit('m32:fxRtnSendOn',      d));
  // volatile: drop stale meter frames if socket buffer is busy (prevents latency buildup)
  m32Manager.on('inputMeters',  (d) => io.volatile.emit('m32:inputMeters',  d));
  m32Manager.on('busMeters',    (d) => io.volatile.emit('m32:busMeters',    d));
  m32Manager.on('auxInMeters',  (d) => io.volatile.emit('m32:auxInMeters',  d));
  m32Manager.on('fxRtnMeters',  (d) => io.volatile.emit('m32:fxRtnMeters',  d));

  // ── Client connection ─────────────────────────────────────

  io.on('connection', async (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Handshake: send current server state immediately
    const cfg = await Config.getAll();
    socket.emit('server:handshake', {
      atemIP: cfg.atemIP,
      serverPort: cfg.serverPort,
      atemStatus: {
        status: atemManager.status,
        ip: atemManager.ip,
      },
      m32Status: { status: m32Manager.status, ip: m32Manager._ip },
    });

    // Send current M32 state if connected
    if (m32Manager.status === 'connected') {
      if (Object.keys(m32Manager.channelNames).length)
        socket.emit('m32:channelNames', m32Manager.channelNames);
      if (Object.keys(m32Manager.busNames).length)
        socket.emit('m32:busNames', m32Manager.busNames);
      if (Object.keys(m32Manager.busConfig).length)
        socket.emit('m32:busConfig', m32Manager.busConfig);
      if (Object.keys(m32Manager.busLevels).length)
        for (const [bus, data] of Object.entries(m32Manager.busLevels))
          socket.emit('m32:busLevel', { bus, ...data });
      for (const [key, data] of Object.entries(m32Manager.sendLevels)) {
        const [ch, bus] = key.split(':');
        socket.emit('m32:sendLevel', { ch, bus, ...data });
      }
      if (Object.keys(m32Manager.auxInNames).length)
        socket.emit('m32:auxInNames', m32Manager.auxInNames);
      if (Object.keys(m32Manager.fxRtnNames).length)
        socket.emit('m32:fxRtnNames', m32Manager.fxRtnNames);
      for (const [key, data] of Object.entries(m32Manager.auxInSendLevels)) {
        const [ch, bus] = key.split(':');
        socket.emit('m32:auxInSendLevel', { ch, bus, ...data });
      }
      for (const [key, data] of Object.entries(m32Manager.fxRtnSendLevels)) {
        const [ch, bus] = key.split(':');
        socket.emit('m32:fxRtnSendLevel', { ch, bus, ...data });
      }
    }

    // Send current audio + media + video state if connected
    if (atemManager.status === 'connected' && atemManager.state) {
      const audioState = atemManager.buildAudioState();
      if (audioState) socket.emit('atem:audioState', audioState);
      const mediaState = atemManager.buildMediaState();
      if (mediaState) socket.emit('atem:mediaState', mediaState);
      const videoState = atemManager.buildVideoState();
      if (videoState) socket.emit('atem:videoState', videoState);
    }

    // ── Client → Server events ──────────────────────────────

    // PWA requests to connect ATEM with a new IP
    socket.on('atem:connect', async ({ ip }) => {
      console.log(`[WS] Client ${socket.id} requests ATEM connect: ${ip}`);
      await Config.set('atemIP', ip);
      await atemManager.connect(ip);
    });

    socket.on('atem:disconnect', async () => {
      console.log(`[WS] Client ${socket.id} requests ATEM disconnect`);
      await atemManager.disconnect();
    });

    // Fader / gain control
    socket.on('atem:setGain', async ({ index, gain }) => {
      await atemManager.setChannelGain(index, gain);
    });

    socket.on('atem:setMixOption', async ({ index, mixOption }) => {
      await atemManager.setChannelMixOption(index, mixOption);
    });

    socket.on('atem:setBalance', async ({ index, balance }) => {
      await atemManager.setChannelBalance(index, balance);
    });

    socket.on('atem:setMasterGain', async ({ gain }) => {
      await atemManager.setMasterGain(gain);
    });

    socket.on('atem:setMasterBalance', async ({ balance }) => {
      await atemManager.setMasterBalance(balance);
    });

    socket.on('atem:setMediaPlayerStill', async ({ playerIndex, stillIndex }) => {
      await atemManager.setMediaPlayerStill(playerIndex, stillIndex);
    });

    // Video switcher commands
    socket.on('atem:setPreviewInput', async ({ source }) => {
      await atemManager.setPreviewInput(source);
    });

    socket.on('atem:setProgramInput', async ({ source }) => {
      await atemManager.setProgramInput(source);
    });

    socket.on('atem:performAuto', async () => {
      await atemManager.performAuto();
    });

    socket.on('atem:performCut', async () => {
      await atemManager.performCut();
    });

    socket.on('atem:setTransitionStyle', async ({ style }) => {
      await atemManager.setTransitionStyle(style);
    });

    socket.on('atem:setTransitionPosition', async ({ position }) => {
      await atemManager.setTransitionPosition(position);
    });

    socket.on('atem:performFTB', async () => {
      await atemManager.performFadeToBlack();
    });

    // Downstream Keyer commands
    socket.on('atem:setDSKOnAir', async ({ keyerIndex, onAir }) => {
      await atemManager.setDSKOnAir(keyerIndex, onAir);
    });

    socket.on('atem:autoDSKTransition', async ({ keyerIndex }) => {
      await atemManager.autoDSKTransition(keyerIndex);
    });

    // Server config update from PWA
    socket.on('server:setConfig', async (cfg) => {
      await Config.setAll(cfg);
      io.emit('server:config', cfg);
    });

    // ── M32 commands ────────────────────────────────────────
    socket.on('m32:connect', ({ ip }) => {
      console.log(`[M32] Client requests connect: ${ip}`);
      m32Manager.connect(ip);
    });

    socket.on('m32:disconnect', () => {
      console.log('[M32] Client requests disconnect');
      m32Manager.disconnect();
    });

    socket.on('m32:setChannelSendLevel', ({ ch, bus, level }) => {
      m32Manager.setChannelSendLevel(ch, bus, level);
    });

    socket.on('m32:setChannelSendOn', ({ ch, bus, on }) => {
      m32Manager.setChannelSendOn(ch, bus, on);
    });

    socket.on('m32:setBusLevel', ({ bus, level }) => {
      m32Manager.setBusLevel(bus, level);
    });

    socket.on('m32:setBusOn', ({ bus, on }) => {
      m32Manager.setBusOn(bus, on);
    });

    socket.on('m32:queryBus', ({ bus }) => {
      m32Manager.queryBus(bus);
    });

    socket.on('m32:setAuxInSendLevel', ({ ch, bus, level }) => {
      m32Manager.setAuxInSendLevel(ch, bus, level);
    });

    socket.on('m32:setAuxInSendOn', ({ ch, bus, on }) => {
      m32Manager.setAuxInSendOn(ch, bus, on);
    });

    socket.on('m32:setFxRtnSendLevel', ({ ch, bus, level }) => {
      m32Manager.setFxRtnSendLevel(ch, bus, level);
    });

    socket.on('m32:setFxRtnSendOn', ({ ch, bus, on }) => {
      m32Manager.setFxRtnSendOn(ch, bus, on);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[WS] Socket.io server listening on port ${port}`);
  });
}

// ── VU Meter throttle engine ─────────────────────────────────

function scheduleVuFlush() {
  if (vuTimer) return; // already scheduled
  const now = Date.now();
  const delay = Math.max(0, VU_THROTTLE_MS - (now - lastVuEmit));
  vuTimer = setTimeout(flushVu, delay);
}

function flushVu() {
  vuTimer = null;
  if (!pendingVu || !io) return;

  const filtered = filterVuDelta(pendingVu);
  if (filtered) {
    io.emit('atem:vuMeter', filtered);
    // Merge into snapshot
    for (const [key, val] of Object.entries(filtered)) {
      lastVuSnapshot[key] = val;
    }
  }

  lastVuEmit = Date.now();
  pendingVu = null;
}

function filterVuDelta(levels) {
  const out = {};
  let hasChange = false;

  for (const [ch, val] of Object.entries(levels)) {
    const prev = lastVuSnapshot[ch];
    if (
      !prev ||
      Math.abs(val.left - prev.left) > VU_DELTA_THRESHOLD ||
      Math.abs(val.right - prev.right) > VU_DELTA_THRESHOLD
    ) {
      out[ch] = val;
      hasChange = true;
    }
  }

  return hasChange ? out : null;
}


function stop() {
  if (vuTimer) { clearTimeout(vuTimer); vuTimer = null; }
  if (io) io.close();
  if (httpServer) httpServer.close();
}

module.exports = { start, stop };

// ── Standalone entry point ────────────────────────────────────
// Run directly: node src/socket-bridge.js
// Reads config.json from CWD (or DEFAULTS) — no Electron required.
if (require.main === module) {
  const Config = require('./config');
  (async () => {
    const cfg = await Config.getAll();
    const port = cfg.serverPort || 4000;
    console.log(`[WS] Standalone mode — starting on port ${port}`);
    start(port);

    if (cfg.atemIP) {
      console.log(`[ATEM] Auto-connecting to ${cfg.atemIP}...`);
      atemManager.connect(cfg.atemIP);
    } else {
      console.log('[ATEM] No atemIP in config — connect via socket event atem:connect');
    }

    process.on('SIGINT', () => {
      console.log('\n[WS] Shutting down...');
      stop();
      atemManager.disconnect();
      process.exit(0);
    });
  })();
}
