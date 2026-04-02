/**
 * Socket Bridge — Socket.io server that relays ATEM state to PWA clients.
 * Implements VU Meter throttling: batches level updates at 30fps max.
 * Only emits if delta exceeds threshold to reduce bandwidth.
 */
const { createServer } = require('http');
const { Server } = require('socket.io');
const atemManager = require('./atem-manager');
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
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
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

  atemManager.on('vuMeter', (levels) => {
    pendingVu = levels;
    scheduleVuFlush();
  });

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
    });

    // Send current audio + media state if connected
    if (atemManager.status === 'connected' && atemManager.state) {
      const audioState = atemManager.buildAudioState();
      if (audioState) socket.emit('atem:audioState', audioState);
      const mediaState = atemManager.buildMediaState();
      if (mediaState) socket.emit('atem:mediaState', mediaState);
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

    // Server config update from PWA
    socket.on('server:setConfig', async (cfg) => {
      await Config.setAll(cfg);
      io.emit('server:config', cfg);
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
