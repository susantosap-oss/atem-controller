/**
 * useM32 — Midas M32R state + commands via Socket.io.
 * Tracks channel names, bus names/config, send levels, bus levels,
 * and VU meters (input + bus) with RAF smoothing (α = 0.3).
 *
 * M32 level convention: raw 0.0–1.0 (0.75 = unity / 0 dB).
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { LevelData } from '@/lib/constants';

// ── Types ─────────────────────────────────────────────────────

export interface M32Status {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  ip?: string | null;
  error?: string;
}

export interface M32SendEntry {
  level: number;  // 0.0 – 1.0
  on: boolean;
}

export interface M32BusEntry {
  level: number;  // 0.0 – 1.0
  on: boolean;
}

export interface M32State {
  status:       M32Status;
  channelNames: Record<string, string>;         // '01'..'32'
  busNames:     Record<string, string>;         // '01'..'16'
  busConfig:    Record<string, { mono: boolean }>; // '01'..'16'
  sendLevels:   Record<string, M32SendEntry>;   // 'ch:bus' key
  busLevels:    Record<string, M32BusEntry>;    // '01'..'16'
  inputVu:      Record<string, LevelData>;      // '01'..'32'
  busVu:        Record<string, LevelData>;      // '01'..'16'
}

const VU_SMOOTH = 0.3;

const DEFAULT_CHANNEL_NAMES: Record<string, string> = {};
for (let i = 1; i <= 32; i++)
  DEFAULT_CHANNEL_NAMES[String(i).padStart(2, '0')] = `CH ${String(i).padStart(2, ' ')}`;

// ── Hook ──────────────────────────────────────────────────────

export function useM32(socket: Socket | null) {
  const [m32Status, setM32Status] = useState<M32Status>({ status: 'disconnected' });
  const [channelNames, setChannelNames] = useState<Record<string, string>>(DEFAULT_CHANNEL_NAMES);
  const [busNames, setBusNames]         = useState<Record<string, string>>({});
  const [busConfig, setBusConfig]       = useState<Record<string, { mono: boolean }>>({});
  const [sendLevels, setSendLevels]     = useState<Record<string, M32SendEntry>>({});
  const [busLevels, setBusLevels]       = useState<Record<string, M32BusEntry>>({});

  // Raw meter refs (not smoothed)
  const rawInputRef = useRef<Record<string, { left: number; right: number }>>({});
  const rawBusRef   = useRef<Record<string, { left: number; right: number }>>({});

  // Smoothed VU state
  const smoothInputRef = useRef<Record<string, LevelData>>({});
  const smoothBusRef   = useRef<Record<string, LevelData>>({});
  const [inputVu, setInputVu] = useState<Record<string, LevelData>>({});
  const [busVu,   setBusVu]   = useState<Record<string, LevelData>>({});
  const rafRef = useRef<number>(0);

  // ── RAF VU smooth loop ───────────────────────────────────
  useEffect(() => {
    const loop = () => {
      let changed = false;

      const nextInput = { ...smoothInputRef.current };
      for (const [ch, raw] of Object.entries(rawInputRef.current)) {
        const prev = nextInput[ch];
        const nl = (prev?.left  ?? raw.left)  * VU_SMOOTH + raw.left  * (1 - VU_SMOOTH);
        const nr = (prev?.right ?? raw.right) * VU_SMOOTH + raw.right * (1 - VU_SMOOTH);
        const pl = Math.max(prev?.peakLeft  ?? nl, raw.left);
        const pr = Math.max(prev?.peakRight ?? nr, raw.right);
        if (!prev || Math.abs(nl - prev.left) > 0.1 || Math.abs(nr - prev.right) > 0.1) {
          nextInput[ch] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
          changed = true;
        }
      }

      const nextBus = { ...smoothBusRef.current };
      for (const [b, raw] of Object.entries(rawBusRef.current)) {
        const prev = nextBus[b];
        const nl = (prev?.left  ?? raw.left)  * VU_SMOOTH + raw.left  * (1 - VU_SMOOTH);
        const nr = (prev?.right ?? raw.right) * VU_SMOOTH + raw.right * (1 - VU_SMOOTH);
        const pl = Math.max(prev?.peakLeft  ?? nl, raw.left);
        const pr = Math.max(prev?.peakRight ?? nr, raw.right);
        if (!prev || Math.abs(nl - prev.left) > 0.1 || Math.abs(nr - prev.right) > 0.1) {
          nextBus[b] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
          changed = true;
        }
      }

      if (changed) {
        smoothInputRef.current = nextInput;
        smoothBusRef.current   = nextBus;
        setInputVu(nextInput);
        setBusVu(nextBus);
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Socket events ─────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onHandshake = (data: { m32Status?: M32Status }) => {
      if (data.m32Status) setM32Status(data.m32Status);
    };
    const onStatus       = (d: M32Status) => setM32Status(d);
    const onChannelNames = (d: Record<string, string>) => setChannelNames(d);
    const onBusNames     = (d: Record<string, string>) => setBusNames(d);
    const onBusConfig    = (d: Record<string, { mono: boolean }>) => setBusConfig(d);

    const onSendLevel = (d: { ch: string; bus: string; level: number; on: boolean }) => {
      setSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
    };
    const onSendOn = (d: { ch: string; bus: string; level: number; on: boolean }) => {
      setSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
    };
    const onBusLevel = (d: { bus: string; level: number; on: boolean }) => {
      setBusLevels(prev => ({ ...prev, [d.bus]: { level: d.level, on: d.on } }));
    };
    const onBusOn = (d: { bus: string; level: number; on: boolean }) => {
      setBusLevels(prev => ({ ...prev, [d.bus]: { level: d.level, on: d.on } }));
    };
    const onInputMeters = (d: Record<string, { left: number; right: number }>) => {
      rawInputRef.current = { ...rawInputRef.current, ...d };
    };
    const onBusMeters = (d: Record<string, { left: number; right: number }>) => {
      rawBusRef.current = { ...rawBusRef.current, ...d };
    };

    socket.on('server:handshake', onHandshake);
    socket.on('m32:status',       onStatus);
    socket.on('m32:channelNames', onChannelNames);
    socket.on('m32:busNames',     onBusNames);
    socket.on('m32:busConfig',    onBusConfig);
    socket.on('m32:sendLevel',    onSendLevel);
    socket.on('m32:sendOn',       onSendOn);
    socket.on('m32:busLevel',     onBusLevel);
    socket.on('m32:busOn',        onBusOn);
    socket.on('m32:inputMeters',  onInputMeters);
    socket.on('m32:busMeters',    onBusMeters);

    return () => {
      socket.off('server:handshake', onHandshake);
      socket.off('m32:status',       onStatus);
      socket.off('m32:channelNames', onChannelNames);
      socket.off('m32:busNames',     onBusNames);
      socket.off('m32:busConfig',    onBusConfig);
      socket.off('m32:sendLevel',    onSendLevel);
      socket.off('m32:sendOn',       onSendOn);
      socket.off('m32:busLevel',     onBusLevel);
      socket.off('m32:busOn',        onBusOn);
      socket.off('m32:inputMeters',  onInputMeters);
      socket.off('m32:busMeters',    onBusMeters);
    };
  }, [socket]);

  // ── Commands ──────────────────────────────────────────────

  const connectM32 = useCallback((ip: string) => {
    socket?.emit('m32:connect', { ip });
  }, [socket]);

  const disconnectM32 = useCallback(() => {
    socket?.emit('m32:disconnect');
  }, [socket]);

  const setChannelSendLevel = useCallback((ch: string, bus: string, level: number) => {
    socket?.emit('m32:setChannelSendLevel', { ch, bus, level });
    setSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], level },
    }));
  }, [socket]);

  const setChannelSendOn = useCallback((ch: string, bus: string, on: boolean) => {
    socket?.emit('m32:setChannelSendOn', { ch, bus, on });
    setSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], on },
    }));
  }, [socket]);

  const setBusLevel = useCallback((bus: string, level: number) => {
    socket?.emit('m32:setBusLevel', { bus, level });
    setBusLevels(prev => ({
      ...prev,
      [bus]: { ...prev[bus], level },
    }));
  }, [socket]);

  const setBusOn = useCallback((bus: string, on: boolean) => {
    socket?.emit('m32:setBusOn', { bus, on });
    setBusLevels(prev => ({
      ...prev,
      [bus]: { ...prev[bus], on },
    }));
  }, [socket]);

  const queryBus = useCallback((busNum: number) => {
    socket?.emit('m32:queryBus', { bus: busNum });
  }, [socket]);

  return {
    m32Status,
    channelNames,
    busNames,
    busConfig,
    sendLevels,
    busLevels,
    inputVu,
    busVu,
    connectM32,
    disconnectM32,
    setChannelSendLevel,
    setChannelSendOn,
    setBusLevel,
    setBusOn,
    queryBus,
  };
}
