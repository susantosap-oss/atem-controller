/**
 * main.js — Electron main process.
 * Responsibilities:
 *  - Create main BrowserWindow (server dashboard)
 *  - System tray (minimize-to-tray, double-click restore)
 *  - Auto-launch on Windows startup
 *  - Start Socket.io bridge on configured port
 *  - Boot ATEM connection from saved IP
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
} = require('electron');
const path = require('path');
const os   = require('os');
const AutoLaunch = require('auto-launch');
const { createTray } = require('./tray');
const socketBridge = require('./socket-bridge');
const atemManager = require('./atem-manager');
const Config = require('./config');

// Prevent multiple instances
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

nativeTheme.themeSource = 'dark';

let mainWindow = null;
let trayObj = null;
app.isQuitting = false;

const autoLauncher = new AutoLaunch({
  name: 'ATEM Controller',
  path: app.getPath('exe'),
});

// ── Window creation ───────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 600,
    minWidth: 400,
    minHeight: 500,
    title: 'ATEM Controller Server',
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    frame: true,
    resizable: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Minimize to tray on close
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────

app.whenReady().then(async () => {
  await createWindow();

  // Create system tray
  const { tray, updateMenu } = createTray(mainWindow);
  trayObj = tray;

  // Forward ATEM status to tray & renderer
  atemManager.on('status', ({ status, message, ip }) => {
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    updateMenu(label);
    mainWindow.webContents.send('atem:status', { status, message, ip });
  });

  // Load config and start services
  const cfg = await Config.getAll();

  // Start Socket bridge (binds to 0.0.0.0 — accessible from LAN)
  await socketBridge.start(cfg.serverPort);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('server:ready', {
      port: cfg.serverPort,
      atemIP: cfg.atemIP,
      localIP: getLocalIP(),
    });
  });

  // Auto-connect saved IP if set
  if (cfg.atemIP) {
    await atemManager.connect(cfg.atemIP);
  }

  // Apply run-on-startup setting
  try {
    const shouldLaunch = cfg.runOnStartup;
    const isEnabled = await autoLauncher.isEnabled();
    if (shouldLaunch && !isEnabled) await autoLauncher.enable();
    else if (!shouldLaunch && isEnabled) await autoLauncher.disable();
  } catch (err) {
    console.warn('[AutoLaunch]', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  socketBridge.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // On Windows we keep running in tray
  }
});

// ── IPC Handlers ──────────────────────────────────────────────

ipcMain.handle('config:get', async () => Config.getAll());

ipcMain.handle('config:set', async (_, updates) => {
  await Config.setAll(updates);

  // Handle startup toggle
  if (typeof updates.runOnStartup === 'boolean') {
    try {
      if (updates.runOnStartup) await autoLauncher.enable();
      else await autoLauncher.disable();
    } catch (err) {
      console.warn('[AutoLaunch]', err.message);
    }
  }

  return { ok: true };
});

ipcMain.handle('atem:connect', async (_, { ip }) => {
  await Config.set('atemIP', ip);
  await atemManager.connect(ip);
  return { ok: true };
});

ipcMain.handle('atem:disconnect', async () => {
  await atemManager.disconnect();
  return { ok: true };
});

ipcMain.handle('atem:getStatus', () => ({
  status: atemManager.status,
  ip: atemManager.ip,
}));

ipcMain.handle('open:logs', () => {
  shell.openPath(app.getPath('logs'));
});

ipcMain.handle('show:dialog', async (_, opts) => {
  return dialog.showMessageBox(mainWindow, opts);
});

// ── Helpers ───────────────────────────────────────────────────

/**
 * Returns the first non-internal IPv4 address on a physical interface.
 * Prefers 192.168.x.x / 10.x.x.x / 172.16-31.x.x (LAN ranges).
 */
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    // Skip loopback and virtual adapters (VMware, VPN, etc.)
    if (/loopback|lo|vmnet|vethernet|docker/i.test(name)) continue;
    for (const iface of ifaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      candidates.push({ name, address: iface.address });
    }
  }

  // Prefer Ethernet adapters (often named "Ethernet" or "Local Area Connection")
  const eth = candidates.find(c => /ethernet|eth|lan/i.test(c.name));
  if (eth) return eth.address;

  // Fall back to first available LAN IP
  const lan = candidates.find(c => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(c.address));
  if (lan) return lan.address;

  return candidates[0]?.address || '127.0.0.1';
}
