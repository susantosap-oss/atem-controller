/**
 * useSocket — manages Socket.io connection lifecycle.
 * Exposes connection state and reconnect function.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket, reconnectSocket, getStoredServerUrl } from '@/lib/socket';

export type SocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseSocketReturn {
  socket: Socket | null;
  socketStatus: SocketStatus;
  serverUrl: string;
  connect: (url: string) => void;
}

export function useSocket(): UseSocketReturn {
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');
  const [serverUrl, setServerUrl] = useState<string>(getStoredServerUrl);
  // Use state (not ref) so the socket value triggers re-renders
  const [socket, setSocket] = useState<Socket | null>(() => {
    // Initialize immediately on first render (browser only)
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

  return {
    socket,
    socketStatus,
    serverUrl,
    connect,
  };
}
