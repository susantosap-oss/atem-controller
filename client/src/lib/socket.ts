/**
 * Socket singleton — optimized for Android (Capacitor) & Web PWA.
 * Persistent connection shared across the app.
 */
import { io, Socket } from 'socket.io-client';
import { Capacitor } from '@capacitor/core'; // Tambahkan import ini

/**
 * Resolve WebSocket server URL:
 * 1. Android APK (Capacitor): Prioritaskan input user (localStorage).
 * 2. Web Browser: Deteksi otomatis IP LAN.
 */
function resolveDefaultServerUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000'; // SSR guard

  // KHUSUS ANDROID/IOS (Native)
  // Embedded Node.js server berjalan di dalam APK — selalu pakai localhost:4000
  const isNative = Capacitor.isNativePlatform();
  if (isNative) {
    return 'http://localhost:4000';
  }

  // KHUSUS WEB BROWSER (PWA)
  const host = window.location.hostname;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return `http://${host}:4000`;       // Otomatis deteksi IP PC via LAN
  }
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:4000';     // Dev mode di PC itu sendiri
  }

  return ''; // Cloud Run atau akses eksternal -> Munculkan input manual
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

    if (!url) {
      console.warn('Socket URL is empty. Waiting for user input.');
    }

    socket = io(url || 'http://placeholder.local', {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 15000, // Lebih lama — beri waktu Node.js embedded startup
      autoConnect: !!url,
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