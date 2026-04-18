/**
 * useATEM — ATEM state + commands.
 * Di APK (native): pakai AtemPlugin Java langsung (UDP ke ATEM).
 * Di Web: pakai Socket.io ke server PC.
 * VU meter: interpolasi di client via RAF untuk smooth display.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Capacitor } from '@capacitor/core';
import { getStoredAtemIP, setStoredAtemIP } from '@/lib/socket';
import { AtemNative } from '@/lib/atem-native';
import { MixOptionValue, LevelData } from '@/lib/constants';

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

export interface DSKState {
  onAir: boolean;
  inTransition: boolean;
  autoRate: number;
  fillSource: number;
  cutSource: number;
}

export interface VideoState {
  programInput: number;
  previewInput: number;
  transitionStyle: number;
  transitionInProgress: boolean;
  transitionPosition: number;
  fadeToBlack: { isFullyBlack: boolean; inTransition: boolean };
  dsk: DSKState[];
  inputLabels: Record<string, string>;
}

export interface MediaPlayerState {
  sourceType: number;
  stillIndex: number;
  playing: boolean;
  loop: boolean;
}

export interface StillSlot {
  isUsed: boolean;
  fileName: string;
}

export interface MediaState {
  players: Record<string, MediaPlayerState>;
  stillPool: Record<string, StillSlot>;
}

export interface UseATEMReturn {
  atemStatus: ATEMStatus;
  audioState: AudioState | null;
  vuState: VUState;
  mediaState: MediaState | null;
  videoState: VideoState | null;
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
  setPreviewInput: (source: number) => void;
  setProgramInput: (source: number) => void;
  performAuto: () => void;
  performCut: () => void;
  setTransitionStyle: (style: number) => void;
  setTransitionPosition: (position: number) => void;
  performFTB: () => void;
  setDSKOnAir: (keyerIndex: number, onAir: boolean) => void;
  autoDSKTransition: (keyerIndex: number) => void;
}

// ── VU smooth factor ──────────────────────────────────────────

const VU_SMOOTH = 0.25;

// ── Hook ──────────────────────────────────────────────────────

export function useATEM(socket: Socket | null): UseATEMReturn {
  const isNative = Capacitor.isNativePlatform();

  const [atemStatus, setAtemStatus] = useState<ATEMStatus>({ status: 'disconnected' });
  const [audioState, setAudioState] = useState<AudioState | null>(null);
  const [mediaState, setMediaState] = useState<MediaState | null>(null);
  const [videoState, setVideoState] = useState<VideoState | null>(null);
  const [atemIP, setAtemIP] = useState<string>(getStoredAtemIP);

  const rawVuRef  = useRef<VUState>({});
  const [vuState, setVuState] = useState<VUState>({});
  const smoothRef = useRef<VUState>({});
  const rafRef    = useRef<number>(0);

  // ── RAF VU smooth loop (shared native + web) ───────────────
  useEffect(() => {
    const loop = () => {
      const raw = rawVuRef.current;
      const cur = smoothRef.current;
      let changed = false;
      const next: VUState = { ...cur };
      for (const [ch, val] of Object.entries(raw)) {
        const prev = cur[ch];
        if (!prev) {
          next[ch] = { ...val };
          changed = true;
        } else {
          const s = VU_SMOOTH;
          const nl = prev.left  * s + val.left  * (1 - s);
          const nr = prev.right * s + val.right * (1 - s);
          const pl = Math.max(prev.peakLeft,  val.peakLeft);
          const pr = Math.max(prev.peakRight, val.peakRight);
          if (Math.abs(nl - prev.left) > 0.05 || Math.abs(nr - prev.right) > 0.05) {
            next[ch] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
            changed = true;
          }
        }
      }
      if (changed) { smoothRef.current = next; setVuState(next); }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Native event listeners ─────────────────────────────────
  useEffect(() => {
    if (!isNative) return;
    const handles: Array<Promise<{ remove: () => void }>> = [];

    handles.push(AtemNative.addListener('atem:status', (data: ATEMStatus) => {
      setAtemStatus(data);
      if (data.ip) { setAtemIP(data.ip); setStoredAtemIP(data.ip); }
    }));

    handles.push(AtemNative.addListener('atem:audioState', (data: AudioState) => {
      setAudioState(data);
    }));

    handles.push(AtemNative.addListener('atem:videoState', (data: VideoState) => {
      setVideoState(data);
    }));

    handles.push(AtemNative.addListener('atem:vuMeter', (levels: VUState) => {
      rawVuRef.current = { ...rawVuRef.current, ...levels };
    }));

    handles.push(AtemNative.addListener('atem:mediaState', (data: MediaState) => {
      setMediaState(data);
    }));

    return () => {
      handles.forEach(h => h.then(r => r.remove()).catch(() => {}));
    };
  }, [isNative]);

  // ── Web socket event listeners ─────────────────────────────
  useEffect(() => {
    if (isNative || !socket) return;

    const onHandshake = (data: ServerHandshake) => {
      if (data.atemIP) { setAtemIP(data.atemIP); setStoredAtemIP(data.atemIP); }
      setAtemStatus(data.atemStatus);
    };
    const onStatus = (data: ATEMStatus) => {
      setAtemStatus(data);
      if (data.ip) { setAtemIP(data.ip); setStoredAtemIP(data.ip); }
    };
    const onAudioState = (data: AudioState) => setAudioState(data);
    const onMediaState = (data: MediaState) => setMediaState(data);
    const onVideoState = (data: VideoState) => setVideoState(data);
    const onVuMeter = (levels: VUState) => {
      rawVuRef.current = { ...rawVuRef.current, ...levels };
    };

    socket.on('server:handshake', onHandshake);
    socket.on('atem:status',      onStatus);
    socket.on('atem:audioState',  onAudioState);
    socket.on('atem:vuMeter',     onVuMeter);
    socket.on('atem:mediaState',  onMediaState);
    socket.on('atem:videoState',  onVideoState);

    return () => {
      socket.off('server:handshake', onHandshake);
      socket.off('atem:status',      onStatus);
      socket.off('atem:audioState',  onAudioState);
      socket.off('atem:vuMeter',     onVuMeter);
      socket.off('atem:mediaState',  onMediaState);
      socket.off('atem:videoState',  onVideoState);
    };
  }, [isNative, socket]);

  // ── Commands — native ──────────────────────────────────────

  const connectATEM = useCallback((ip: string) => {
    const trimmed = ip.trim();
    if (!trimmed) return;
    setStoredAtemIP(trimmed);
    setAtemIP(trimmed);
    if (isNative) {
      AtemNative.connect({ ip: trimmed }).catch(console.error);
    } else {
      socket?.emit('atem:connect', { ip: trimmed });
    }
  }, [isNative, socket]);

  const disconnectATEM = useCallback(() => {
    if (isNative) {
      AtemNative.disconnect().catch(console.error);
    } else {
      socket?.emit('atem:disconnect');
    }
  }, [isNative, socket]);

  const setChannelGain = useCallback((index: string | number, gain: number) => {
    if (isNative) {
      AtemNative.setChannelGain({ index: Number(index), gain }).catch(console.error);
    } else {
      socket?.emit('atem:setGain', { index: Number(index), gain });
    }
    setAudioState(prev => prev ? {
      ...prev, channels: { ...prev.channels, [index]: { ...prev.channels[index], gain } }
    } : prev);
  }, [isNative, socket]);

  const setChannelMixOption = useCallback((index: string | number, mixOption: MixOptionValue) => {
    if (isNative) {
      AtemNative.setChannelMixOption({ index: Number(index), mixOption }).catch(console.error);
    } else {
      socket?.emit('atem:setMixOption', { index: Number(index), mixOption });
    }
    setAudioState(prev => prev ? {
      ...prev, channels: { ...prev.channels, [index]: { ...prev.channels[index], mixOption } }
    } : prev);
  }, [isNative, socket]);

  const setChannelBalance = useCallback((index: string | number, balance: number) => {
    if (isNative) {
      AtemNative.setChannelBalance({ index: Number(index), balance }).catch(console.error);
    } else {
      socket?.emit('atem:setBalance', { index: Number(index), balance });
    }
    setAudioState(prev => prev ? {
      ...prev, channels: { ...prev.channels, [index]: { ...prev.channels[index], balance } }
    } : prev);
  }, [isNative, socket]);

  const setMasterGain = useCallback((gain: number) => {
    if (isNative) {
      AtemNative.setMasterGain({ gain }).catch(console.error);
    } else {
      socket?.emit('atem:setMasterGain', { gain });
    }
    setAudioState(prev => prev ? { ...prev, master: { ...prev.master, gain } } : prev);
  }, [isNative, socket]);

  const setMasterBalance = useCallback((balance: number) => {
    if (isNative) {
      AtemNative.setMasterBalance({ balance }).catch(console.error);
    } else {
      socket?.emit('atem:setMasterBalance', { balance });
    }
    setAudioState(prev => prev ? { ...prev, master: { ...prev.master, balance } } : prev);
  }, [isNative, socket]);

  const setMediaPlayerStill = useCallback((playerIndex: number, stillIndex: number) => {
    if (isNative) {
      AtemNative.setMediaPlayerStill({ playerIndex, stillIndex }).catch(console.error);
    } else {
      socket?.emit('atem:setMediaPlayerStill', { playerIndex, stillIndex });
    }
    setMediaState(prev => {
      if (!prev) return prev;
      return { ...prev, players: { ...prev.players, [playerIndex]: { ...prev.players[playerIndex], sourceType: 1, stillIndex } } };
    });
  }, [isNative, socket]);

  const setPreviewInput = useCallback((source: number) => {
    if (isNative) {
      AtemNative.setPreviewInput({ source }).catch(console.error);
    } else {
      socket?.emit('atem:setPreviewInput', { source });
    }
    setVideoState(prev => prev ? { ...prev, previewInput: source } : prev);
  }, [isNative, socket]);

  const setProgramInput = useCallback((source: number) => {
    if (isNative) {
      AtemNative.setProgramInput({ source }).catch(console.error);
    } else {
      socket?.emit('atem:setProgramInput', { source });
    }
    setVideoState(prev => prev ? { ...prev, programInput: source } : prev);
  }, [isNative, socket]);

  const performAuto = useCallback(() => {
    if (isNative) AtemNative.performAuto().catch(console.error);
    else socket?.emit('atem:performAuto');
  }, [isNative, socket]);

  const performCut = useCallback(() => {
    if (isNative) AtemNative.performCut().catch(console.error);
    else socket?.emit('atem:performCut');
    setVideoState(prev => prev ? { ...prev, programInput: prev.previewInput } : prev);
  }, [isNative, socket]);

  const setTransitionStyle = useCallback((style: number) => {
    if (isNative) AtemNative.setTransitionStyle({ style }).catch(console.error);
    else socket?.emit('atem:setTransitionStyle', { style });
    setVideoState(prev => prev ? { ...prev, transitionStyle: style } : prev);
  }, [isNative, socket]);

  const setTransitionPosition = useCallback((position: number) => {
    if (isNative) AtemNative.setTransitionPosition({ position }).catch(console.error);
    else socket?.emit('atem:setTransitionPosition', { position });
  }, [isNative, socket]);

  const performFTB = useCallback(() => {
    if (isNative) AtemNative.performFTB().catch(console.error);
    else socket?.emit('atem:performFTB');
  }, [isNative, socket]);

  const setDSKOnAir = useCallback((keyerIndex: number, onAir: boolean) => {
    if (isNative) AtemNative.setDSKOnAir({ keyerIndex, onAir }).catch(console.error);
    else socket?.emit('atem:setDSKOnAir', { keyerIndex, onAir });
    setVideoState(prev => {
      if (!prev?.dsk) return prev;
      const dsk = prev.dsk.map((d, i) => i === keyerIndex ? { ...d, onAir } : d);
      return { ...prev, dsk };
    });
  }, [isNative, socket]);

  const autoDSKTransition = useCallback((keyerIndex: number) => {
    if (isNative) AtemNative.autoDSKTransition({ keyerIndex }).catch(console.error);
    else socket?.emit('atem:autoDSKTransition', { keyerIndex });
  }, [isNative, socket]);

  return {
    atemStatus, audioState, vuState, mediaState, videoState, atemIP,
    isConnected: atemStatus.status === 'connected',
    connectATEM, disconnectATEM,
    setChannelGain, setChannelMixOption, setChannelBalance,
    setMasterGain, setMasterBalance,
    setMediaPlayerStill,
    setPreviewInput, setProgramInput,
    performAuto, performCut,
    setTransitionStyle, setTransitionPosition,
    performFTB, setDSKOnAir, autoDSKTransition,
  };
}
