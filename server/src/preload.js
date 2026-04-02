/**
 * Preload — exposes safe IPC bridge to renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (updates) => ipcRenderer.invoke('config:set', updates),
  connectATEM: (ip) => ipcRenderer.invoke('atem:connect', { ip }),
  disconnectATEM: () => ipcRenderer.invoke('atem:disconnect'),
  getATEMStatus: () => ipcRenderer.invoke('atem:getStatus'),
  openLogs: () => ipcRenderer.invoke('open:logs'),

  onATEMStatus: (cb) => {
    ipcRenderer.on('atem:status', (_, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('atem:status');
  },
  onServerReady: (cb) => {
    ipcRenderer.once('server:ready', (_, data) => cb(data));
  },
});
