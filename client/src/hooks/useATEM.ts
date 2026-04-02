/**
 * useATEM — consumes Socket.io events and exposes ATEM state + commands.
 * VU meter: accepts throttled updates from server, interpolates on client via RAF.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { getStoredAtemIP, setStoredAtemIP } from '@/lib/socket';
import { MixOptionValue, MixOption, LevelData } from '@/lib/constants';

// ── Types ─────────────────────────────────────────────────────

export interface ChannelState {
  gain: number;
  balance: number;
  mixOption: MixOptionValue;
  label: string;
}

export interface MasterState {
  gain: number;
  balance: number;
  followFadeToBlack?: boolean;
}

export interface AudioState {
  channels: Record<string, ChannelState>;
  master: MasterState;
}

export type { LevelData };

export interface VUState {
  [channelOrMaster: string]: LevelData;
}

export interface ATEMStatus {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  message?: string;
  ip?: string;
}

export interface ServerHandshake {
  atemIP: string;
  serverPort: number;
  atemStatus: ATEMStatus;
}

// ── Media types ───────────────────────────────────────────────

export interface MediaPlayerState {
  sourceType: number;  // 1=still, 2=clip
  stillIndex: number;
  playing: boolean;
  loop: boolean;
}

export interface StillSlot {
  isUsed: boolean;
  fileName: string;
}

export interface MediaState {
  players: Record<string, MediaPlayerState>;  // '0'=MP1, '1'=MP2
  stillPool: Record<string, StillSlot>;       // '0'..'19'
}

export interface UseATEMReturn {
  atemStatus: ATEMStatus;
  audioState: AudioState | null;
  vuState: VUState;
  mediaState: MediaState | null;
  atemIP: string;
  isConnected: boolean;
  connectATEM: (ip: string) => void;
  disconnectATEM: () => void;
  setChannelGain: (index: string | number, gain: number) => void;
  setChannelMixOption: (index: string | number, mixOption: MixOptionValue) => void;
  setChannelBalance: (index: string | number, balance: number) => void;
  setMasterGain: (gain: number) => void;
  setMasterBalance: (balance: number) => void;
  setMediaPlayerStill: (playerIndex: number, stillIndex: number) => void;
}

// ── VU Interpolation engine ──────────────────────────────────
// Client smooths received values via exponential decay at 60fps

const VU_SMOOTH_FACTOR = 0.25; // 0=instant, 1=no change per frame

// ── Hook ──────────────────────────────────────────────────────

export function useATEM(socket: Socket | null): UseATEMReturn {
  const [atemStatus, setAtemStatus] = useState<ATEMStatus>({ status: 'disconnected' });
  const [audioState, setAudioState] = useState<AudioState | null>(null);
  const [mediaState, setMediaState] = useState<MediaState | null>(null);
  const [atemIP, setAtemIP] = useState<string>(getStoredAtemIP);

  // VU: server-received raw values
  const rawVuRef  = useRef<VUState>({});
  // VU: smoothed display values (updated by RAF)
  const [vuState, setVuState] = useState<VUState>({});
  const smoothRef = useRef<VUState>({});
  const rafRef    = useRef<number>(0);

  // ── RAF-based VU smooth loop ───────────────────────────────
  useEffect(() => {
    const loop = () => {
      const raw     = rawVuRef.current;
      const current = smoothRef.current;
      let changed = false;

      const next: VUState = { ...current };
      for (const [ch, val] of Object.entries(raw)) {
        const prev = current[ch];
        if (!prev) {
          next[ch] = { ...val };
          changed = true;
        } else {
          const s = VU_SMOOTH_FACTOR;
          const nl = prev.left  * s + val.left  * (1 - s);
          const nr = prev.right * s + val.right * (1 - s);
          const pl = Math.max(prev.peakLeft,  val.peakLeft);
          const pr = Math.max(prev.peakRight, val.peakRight);
          if (
            Math.abs(nl - prev.left)  > 0.05 ||
            Math.abs(nr - prev.right) > 0.05
          ) {
            next[ch] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
            changed = true;
          }
        }
      }

      if (changed) {
        smoothRef.current = next;
        setVuState(next);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Socket event handlers ──────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onHandshake = (data: ServerHandshake) => {
      if (data.atemIP) {
        setAtemIP(data.atemIP);
        setStoredAtemIP(data.atemIP);
      }
      setAtemStatus(data.atemStatus);
    };

    const onStatus = (data: ATEMStatus) => {
      setAtemStatus(data);
      if (data.ip) {
        setAtemIP(data.ip);
        setStoredAtemIP(data.ip);
      }
    };

    const onAudioState = (data: AudioState) => {
      setAudioState(data);
    };

    const onMediaState = (data: MediaState) => {
      setMediaState(data);
    };

    const onVuMeter = (levels: VUState) => {
      // Merge incoming into raw buffer — RAF loop does the smoothing
      rawVuRef.current = { ...rawVuRef.current, ...levels };
    };

    socket.on('server:handshake', onHandshake);
    socket.on('atem:status',      onStatus);
    socket.on('atem:audioState',  onAudioState);
    socket.on('atem:vuMeter',     onVuMeter);
    socket.on('atem:mediaState',  onMediaState);

    return () => {
      socket.off('server:handshake', onHandshake);
      socket.off('atem:status',      onStatus);
      socket.off('atem:audioState',  onAudioState);
      socket.off('atem:vuMeter',     onVuMeter);
      socket.off('atem:mediaState',  onMediaState);
    };
  }, [socket]);

  // ── Commands ───────────────────────────────────────────────

  const connectATEM = useCallback((ip: string) => {
    if (!socket || !ip.trim()) return;
    setStoredAtemIP(ip.trim());
    setAtemIP(ip.trim());
    socket.emit('atem:connect', { ip: ip.trim() });
  }, [socket]);

  const disconnectATEM = useCallback(() => {
    if (!socket) return;
    socket.emit('atem:disconnect');
  }, [socket]);

  const setChannelGain = useCallback((index: string | number, gain: number) => {
    socket?.emit('atem:setGain', { index: Number(index), gain });
    // Optimistic local update
    setAudioState(prev => prev ? {
      ...prev,
      channels: { ...prev.channels, [index]: { ...prev.channels[index], gain } }
    } : prev);
  }, [socket]);

  const setChannelMixOption = useCallback((index: string | number, mixOption: MixOptionValue) => {
    socket?.emit('atem:setMixOption', { index: Number(index), mixOption });
    setAudioState(prev => prev ? {
      ...prev,
      channels: { ...prev.channels, [index]: { ...prev.channels[index], mixOption } }
    } : prev);
  }, [socket]);

  const setChannelBalance = useCallback((index: string | number, balance: number) => {
    socket?.emit('atem:setBalance', { index: Number(index), balance });
    setAudioState(prev => prev ? {
      ...prev,
      channels: { ...prev.channels, [index]: { ...prev.channels[index], balance } }
    } : prev);
  }, [socket]);

  const setMasterGain = useCallback((gain: number) => {
    socket?.emit('atem:setMasterGain', { gain });
    setAudioState(prev => prev ? {
      ...prev, master: { ...prev.master, gain }
    } : prev);
  }, [socket]);

  const setMasterBalance = useCallback((balance: number) => {
    socket?.emit('atem:setMasterBalance', { balance });
    setAudioState(prev => prev ? {
      ...prev, master: { ...prev.master, balance }
    } : prev);
  }, [socket]);

  const setMediaPlayerStill = useCallback((playerIndex: number, stillIndex: number) => {
    socket?.emit('atem:setMediaPlayerStill', { playerIndex, stillIndex });
    // Optimistic update
    setMediaState(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        players: {
          ...prev.players,
          [playerIndex]: { ...prev.players[playerIndex], sourceType: 1, stillIndex },
        },
      };
    });
  }, [socket]);

  return {
    atemStatus,
    audioState,
    vuState,
    mediaState,
    atemIP,
    isConnected: atemStatus.status === 'connected',
    connectATEM,
    disconnectATEM,
    setChannelGain,
    setChannelMixOption,
    setChannelBalance,
    setMasterGain,
    setMasterBalance,
    setMediaPlayerStill,
  };
}
