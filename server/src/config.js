/**
 * Config Manager — persists settings to JSON via electron-settings.
 * Keys: atemIP, serverPort, runOnStartup
 */
const settings = require('electron-settings');

const DEFAULTS = {
  atemIP: '192.168.1.150',   // ATEM Mini Pro via Ethernet static IP
  serverPort: 4000,          // Socket.io bridge — accessible over LAN WiFi
  runOnStartup: false,
};

const Config = {
  async get(key) {
    const val = await settings.get(key);
    return val !== undefined ? val : DEFAULTS[key];
  },

  async set(key, value) {
    await settings.set(key, value);
  },

  async getAll() {
    const stored = await settings.getAll();
    return { ...DEFAULTS, ...stored };
  },

  async setAll(obj) {
    for (const [k, v] of Object.entries(obj)) {
      await settings.set(k, v);
    }
  },
};

module.exports = Config;
