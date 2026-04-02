/**
 * Socket singleton — one persistent connection shared across the app.
 * Server URL stored in localStorage with fallback.
 */
import { io, Socket } from 'socket.io-client';

/**
 * Resolve WebSocket server URL berdasarkan konteks akses:
 *
 *  1. LAN IP (192.168.x / 10.x / 172.16-31.x)
 *     → HP buka PWA via IP PC = server ada di PC yang sama → http://[ip]:4000
 *
 *  2. localhost / 127.0.0.1
 *     → Dev mode di PC itu sendiri → http://localhost:4000
 *
 *  3. Domain eksternal (Cloud Run, dll)
 *     → '' kosong → ConnectionPanel tampilkan placeholder, user isi manual
 *        (URL disimpan ke localStorage setelah user connect)
 */
function resolveDefaultServerUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000'; // SSR guard
  const host = window.location.hostname;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return `http://${host}:4000`;       // LAN: PC IP otomatis
  }
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:4000';     // Dev
  }
  return '';  // Cloud Run / external → user harus isi di ConnectionPanel
}

export const DEFAULT_SERVER_URL: string = resolveDefaultServerUrl();
export const LS_KEY_SERVER_URL  = 'atem_server_url';
export const LS_KEY_ATEM_IP     = 'atem_ip';

let socket: Socket | null = null;

export function getStoredServerUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_SERVER_URL;
  return localStorage.getItem(LS_KEY_SERVER_URL) || DEFAULT_SERVER_URL;
}

export function setStoredServerUrl(url: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(LS_KEY_SERVER_URL, url);
  }
}

export function getStoredAtemIP(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_KEY_ATEM_IP) || '';
}

export function setStoredAtemIP(ip: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(LS_KEY_ATEM_IP, ip);
  }
}

export function getSocket(): Socket {
  if (!socket) {
    const url = getStoredServerUrl();
    socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
      autoConnect: true,
    });
  }
  return socket;
}

export function reconnectSocket(url: string): Socket {
  if (socket) {
    socket.disconnect();
    socket.removeAllListeners();
    socket = null;
  }
  setStoredServerUrl(url);
  return getSocket();
}
