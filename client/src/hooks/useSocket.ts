/**
 * useSocket — manages Socket.io connection lifecycle.
 * Di APK (native): langsung return 'connected' — plugin native yang handles komunikasi.
 * Di Web: socket.io seperti biasa.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Capacitor } from '@capacitor/core';
import { getSocket, reconnectSocket, getStoredServerUrl } from '@/lib/socket';

export type SocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseSocketReturn {
  socket: Socket | null;
  socketStatus: SocketStatus;
  serverUrl: string;
  connect: (url: string) => void;
}

export function useSocket(): UseSocketReturn {
  // Di native: plugin Java yang handle — socket.io tidak dipakai
  if (Capacitor.isNativePlatform()) {
    return {
      socket: null,
      socketStatus: 'connected', // Plugin native selalu "siap"
      serverUrl: 'native',
      connect: () => {},
    };
  }

  // Web path — socket.io seperti biasa
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSocketWeb();
}

function useSocketWeb(): UseSocketReturn {
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');
  const [serverUrl, setServerUrl] = useState<string>(getStoredServerUrl);
  const [socket, setSocket] = useState<Socket | null>(() => {
    if (typeof window === 'undefined') return null;
    return getSocket();
  });

  const attachListeners = useCallback((sock: Socket) => {
    sock.on('connect',          () => setSocketStatus('connected'));
    sock.on('disconnect',       () => setSocketStatus('disconnected'));
    sock.on('connect_error',    () => setSocketStatus('error'));
    sock.on('reconnect',        () => setSocketStatus('connected'));
    sock.on('reconnect_attempt',() => setSocketStatus('connecting'));
  }, []);

  useEffect(() => {
    const sock = getSocket();
    if (sock !== socket) setSocket(sock);
    attachListeners(sock);
    if (sock.connected) setSocketStatus('connected');

    return () => {
      sock.off('connect');
      sock.off('disconnect');
      sock.off('connect_error');
      sock.off('reconnect');
      sock.off('reconnect_attempt');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachListeners]);

  const connect = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setServerUrl(trimmed);
    setSocketStatus('connecting');
    const newSock = reconnectSocket(trimmed);
    setSocket(newSock);
    attachListeners(newSock);
  }, [attachListeners]);

  return { socket, socketStatus, serverUrl, connect };
}
