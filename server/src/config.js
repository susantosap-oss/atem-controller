/**
 * Config Manager — environment-aware settings persistence.
 * - Electron: uses electron-settings (JSON in %APPDATA%)
 * - Node headless: uses config.json in process.cwd()
 */
const path = require('path');
const fs   = require('fs');

const DEFAULTS = {
  atemIP:       '192.168.1.150',
  serverPort:   4000,
  runOnStartup: false,
};

// ── Environment detection ──────────────────────────────────────

function isElectron() {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.electron != null
  );
}

// ── Headless (pure Node) backend ───────────────────────────────

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

function _readFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function _writeFile(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Config] Could not write config.json:', err.message);
  }
}

// ── Config API ─────────────────────────────────────────────────

const Config = {
  async get(key) {
    if (isElectron()) {
      const settings = require('electron-settings');
      const val = await settings.get(key);
      return val !== undefined ? val : DEFAULTS[key];
    }
    const stored = _readFile();
    return stored[key] !== undefined ? stored[key] : DEFAULTS[key];
  },

  async set(key, value) {
    if (isElectron()) {
      const settings = require('electron-settings');
      await settings.set(key, value);
      return;
    }
    const stored = _readFile();
    stored[key] = value;
    _writeFile(stored);
  },

  async getAll() {
    if (isElectron()) {
      const settings = require('electron-settings');
      let stored = {};
      try {
        // electron-settings v4: getAll() returns the full settings object
        if (typeof settings.getAll === 'function') {
          stored = (await settings.getAll()) || {};
        } else {
          // fallback: read each key individually
          for (const key of Object.keys(DEFAULTS)) {
            const v = await settings.get(key);
            if (v !== undefined) stored[key] = v;
          }
        }
      } catch {
        stored = {};
      }
      return { ...DEFAULTS, ...stored };
    }
    return { ...DEFAULTS, ..._readFile() };
  },

  async setAll(obj) {
    if (isElectron()) {
      const settings = require('electron-settings');
      for (const [k, v] of Object.entries(obj)) {
        await settings.set(k, v);
      }
      return;
    }
    const stored = _readFile();
    Object.assign(stored, obj);
    _writeFile(stored);
  },
};

module.exports = Config;
