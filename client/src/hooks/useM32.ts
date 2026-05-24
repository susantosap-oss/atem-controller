/**
 * useM32 — Midas M32R state + commands.
 * - Native Android (APK): pakai M32Plugin via Capacitor (OSC UDP langsung ke M32)
 * - Web/PWA: pakai Socket.io ke server PC
 *
 * M32 level convention: raw 0.0–1.0 (0.75 = unity / 0 dB).
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Socket } from 'socket.io-client';
import { LevelData } from '@/lib/constants';
import { M32Native } from '@/lib/m32-native';

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
  status:           M32Status;
  channelNames:     Record<string, string>;            // '01'..'32'
  busNames:         Record<string, string>;            // '01'..'16'
  busConfig:        Record<string, { mono: boolean }>; // '01'..'16'
  sendLevels:       Record<string, M32SendEntry>;      // 'ch:bus' key
  sendPre:          Record<string, boolean>;           // 'ch:bus' key, true=pre-fader
  busLevels:        Record<string, M32BusEntry>;       // '01'..'16'
  inputVu:          Record<string, LevelData>;         // '01'..'32'
  busVu:            Record<string, LevelData>;         // '01'..'16'
  auxInNames:       Record<string, string>;            // '01'..'08'
  fxRtnNames:       Record<string, string>;            // '01'..'04'
  auxInSendLevels:  Record<string, M32SendEntry>;      // 'ch:bus' key
  fxRtnSendLevels:  Record<string, M32SendEntry>;      // 'ch:bus' key
  auxInVu:          Record<string, LevelData>;         // '01'..'08'
  fxRtnVu:          Record<string, LevelData>;         // '01'..'04'
}

// Smoothing constants — linear amplitude domain (correct VU ballistics)
const VU_ATTACK  = 0.05;   // fast attack:  ~95% of target in 2–3 frames
const VU_RELEASE = 0.55;   // slow release: ~300 ms at 60 fps

// Peak hold: 1.5 s then decays at 12 dB/s
const PEAK_HOLD_FRAMES = 90;
const PEAK_DECAY_DB    = 0.2;   // dB per frame after hold

// dB ↔ linear helpers for correct amplitude smoothing
function toLinear(db: number): number {
  return db <= -90 ? 0 : Math.pow(10, db / 20);
}
function toDb(lin: number): number {
  return lin <= 0 ? -90 : Math.max(-90, 20 * Math.log10(lin));
}

interface PeakState { pl: number; pr: number; al: number; ar: number }

const DEFAULT_CHANNEL_NAMES: Record<string, string> = {};
for (let i = 1; i <= 32; i++)
  DEFAULT_CHANNEL_NAMES[String(i).padStart(2, '0')] = `CH ${String(i).padStart(2, ' ')}`;

const IS_NATIVE = Capacitor.isNativePlatform();

// ── Hook ──────────────────────────────────────────────────────

export function useM32(socket: Socket | null) {
  const [m32Status, setM32Status] = useState<M32Status>({ status: 'disconnected' });
  const [channelNames, setChannelNames] = useState<Record<string, string>>(DEFAULT_CHANNEL_NAMES);
  const [busNames, setBusNames]         = useState<Record<string, string>>({});
  const [busConfig, setBusConfig]       = useState<Record<string, { mono: boolean }>>({});
  const [sendLevels, setSendLevels]     = useState<Record<string, M32SendEntry>>({});
  const [sendPre, setSendPre]           = useState<Record<string, boolean>>({});
  const [busLevels, setBusLevels]       = useState<Record<string, M32BusEntry>>({});
  const [auxInNames, setAuxInNames]           = useState<Record<string, string>>({});
  const [fxRtnNames, setFxRtnNames]           = useState<Record<string, string>>({});
  const [auxInSendLevels, setAuxInSendLevels] = useState<Record<string, M32SendEntry>>({});
  const [fxRtnSendLevels, setFxRtnSendLevels] = useState<Record<string, M32SendEntry>>({});

  // Raw meter refs (not smoothed) — dB values from server
  const rawInputRef  = useRef<Record<string, { left: number; right: number }>>({});
  const rawBusRef    = useRef<Record<string, { left: number; right: number }>>({});
  const rawAuxInRef  = useRef<Record<string, { left: number; right: number }>>({});
  const rawFxRtnRef  = useRef<Record<string, { left: number; right: number }>>({});

  // Smoothed VU state
  const smoothInputRef  = useRef<Record<string, LevelData>>({});
  const smoothBusRef    = useRef<Record<string, LevelData>>({});
  const smoothAuxInRef  = useRef<Record<string, LevelData>>({});
  const smoothFxRtnRef  = useRef<Record<string, LevelData>>({});
  const [inputVu,  setInputVu]  = useState<Record<string, LevelData>>({});
  const [busVu,    setBusVu]    = useState<Record<string, LevelData>>({});
  const [auxInVu,  setAuxInVu]  = useState<Record<string, LevelData>>({});
  const [fxRtnVu,  setFxRtnVu]  = useState<Record<string, LevelData>>({});
  const rafRef = useRef<number>(0);

  // Peak hold tracking (separate from smoothed value)
  const peakInputRef  = useRef<Record<string, PeakState>>({});
  const peakBusRef    = useRef<Record<string, PeakState>>({});
  const peakAuxInRef  = useRef<Record<string, PeakState>>({});
  const peakFxRtnRef  = useRef<Record<string, PeakState>>({});

  // ── RAF VU smooth loop ───────────────────────────────────
  useEffect(() => {
    const loop = () => {
      let changed = false;

      const nextInput = { ...smoothInputRef.current };
      for (const [ch, raw] of Object.entries(rawInputRef.current)) {
        const prev = nextInput[ch];

        // Smooth in linear amplitude domain for accurate VU ballistics
        const rawLinL  = toLinear(raw.left);
        const rawLinR  = toLinear(raw.right);
        const prevLinL = toLinear(prev?.left  ?? -90);
        const prevLinR = toLinear(prev?.right ?? -90);

        const coeffL = rawLinL > prevLinL ? VU_ATTACK : VU_RELEASE;
        const coeffR = rawLinR > prevLinR ? VU_ATTACK : VU_RELEASE;
        const nlLin  = prevLinL * coeffL + rawLinL * (1 - coeffL);
        const nrLin  = prevLinR * coeffR + rawLinR * (1 - coeffR);
        const nl = toDb(nlLin);
        const nr = toDb(nrLin);

        // Peak hold with timed decay
        const pk = peakInputRef.current[ch] ?? { pl: -90, pr: -90, al: PEAK_HOLD_FRAMES, ar: PEAK_HOLD_FRAMES };
        let { pl, pr, al, ar } = pk;

        if (raw.left >= pl)  { pl = raw.left;  al = 0; }
        else { al++; if (al > PEAK_HOLD_FRAMES) pl = Math.max(nl, pl - PEAK_DECAY_DB); }
        if (raw.right >= pr) { pr = raw.right; ar = 0; }
        else { ar++; if (ar > PEAK_HOLD_FRAMES) pr = Math.max(nr, pr - PEAK_DECAY_DB); }
        peakInputRef.current[ch] = { pl, pr, al, ar };

        if (
          !prev ||
          Math.abs(nl - prev.left)  > 0.05 || Math.abs(nr - prev.right) > 0.05 ||
          Math.abs(pl - (prev.peakLeft  ?? -90)) > 0.05 ||
          Math.abs(pr - (prev.peakRight ?? -90)) > 0.05
        ) {
          nextInput[ch] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
          changed = true;
        }
      }

      const nextBus = { ...smoothBusRef.current };
      for (const [b, raw] of Object.entries(rawBusRef.current)) {
        const prev = nextBus[b];

        const rawLinL  = toLinear(raw.left);
        const rawLinR  = toLinear(raw.right);
        const prevLinL = toLinear(prev?.left  ?? -90);
        const prevLinR = toLinear(prev?.right ?? -90);

        const coeffL = rawLinL > prevLinL ? VU_ATTACK : VU_RELEASE;
        const coeffR = rawLinR > prevLinR ? VU_ATTACK : VU_RELEASE;
        const nlLin  = prevLinL * coeffL + rawLinL * (1 - coeffL);
        const nrLin  = prevLinR * coeffR + rawLinR * (1 - coeffR);
        const nl = toDb(nlLin);
        const nr = toDb(nrLin);

        const pk = peakBusRef.current[b] ?? { pl: -90, pr: -90, al: PEAK_HOLD_FRAMES, ar: PEAK_HOLD_FRAMES };
        let { pl, pr, al, ar } = pk;

        if (raw.left >= pl)  { pl = raw.left;  al = 0; }
        else { al++; if (al > PEAK_HOLD_FRAMES) pl = Math.max(nl, pl - PEAK_DECAY_DB); }
        if (raw.right >= pr) { pr = raw.right; ar = 0; }
        else { ar++; if (ar > PEAK_HOLD_FRAMES) pr = Math.max(nr, pr - PEAK_DECAY_DB); }
        peakBusRef.current[b] = { pl, pr, al, ar };

        if (
          !prev ||
          Math.abs(nl - prev.left)  > 0.05 || Math.abs(nr - prev.right) > 0.05 ||
          Math.abs(pl - (prev.peakLeft  ?? -90)) > 0.05 ||
          Math.abs(pr - (prev.peakRight ?? -90)) > 0.05
        ) {
          nextBus[b] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
          changed = true;
        }
      }

      // ── AuxIn smooth ──
      const nextAuxIn = { ...smoothAuxInRef.current };
      for (const [ch, raw] of Object.entries(rawAuxInRef.current)) {
        const prev = nextAuxIn[ch];
        const rawLinL  = toLinear(raw.left);
        const rawLinR  = toLinear(raw.right);
        const prevLinL = toLinear(prev?.left  ?? -90);
        const prevLinR = toLinear(prev?.right ?? -90);
        const coeffL = rawLinL > prevLinL ? VU_ATTACK : VU_RELEASE;
        const coeffR = rawLinR > prevLinR ? VU_ATTACK : VU_RELEASE;
        const nlLin  = prevLinL * coeffL + rawLinL * (1 - coeffL);
        const nrLin  = prevLinR * coeffR + rawLinR * (1 - coeffR);
        const nl = toDb(nlLin);
        const nr = toDb(nrLin);
        const pk = peakAuxInRef.current[ch] ?? { pl: -90, pr: -90, al: PEAK_HOLD_FRAMES, ar: PEAK_HOLD_FRAMES };
        let { pl, pr, al, ar } = pk;
        if (raw.left >= pl)  { pl = raw.left;  al = 0; }
        else { al++; if (al > PEAK_HOLD_FRAMES) pl = Math.max(nl, pl - PEAK_DECAY_DB); }
        if (raw.right >= pr) { pr = raw.right; ar = 0; }
        else { ar++; if (ar > PEAK_HOLD_FRAMES) pr = Math.max(nr, pr - PEAK_DECAY_DB); }
        peakAuxInRef.current[ch] = { pl, pr, al, ar };
        if (!prev || Math.abs(nl - prev.left) > 0.05 || Math.abs(nr - prev.right) > 0.05 ||
            Math.abs(pl - (prev.peakLeft ?? -90)) > 0.05 || Math.abs(pr - (prev.peakRight ?? -90)) > 0.05) {
          nextAuxIn[ch] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
          changed = true;
        }
      }

      // ── FxRtn smooth ──
      const nextFxRtn = { ...smoothFxRtnRef.current };
      for (const [ch, raw] of Object.entries(rawFxRtnRef.current)) {
        const prev = nextFxRtn[ch];
        const rawLinL  = toLinear(raw.left);
        const rawLinR  = toLinear(raw.right);
        const prevLinL = toLinear(prev?.left  ?? -90);
        const prevLinR = toLinear(prev?.right ?? -90);
        const coeffL = rawLinL > prevLinL ? VU_ATTACK : VU_RELEASE;
        const coeffR = rawLinR > prevLinR ? VU_ATTACK : VU_RELEASE;
        const nlLin  = prevLinL * coeffL + rawLinL * (1 - coeffL);
        const nrLin  = prevLinR * coeffR + rawLinR * (1 - coeffR);
        const nl = toDb(nlLin);
        const nr = toDb(nrLin);
        const pk = peakFxRtnRef.current[ch] ?? { pl: -90, pr: -90, al: PEAK_HOLD_FRAMES, ar: PEAK_HOLD_FRAMES };
        let { pl, pr, al, ar } = pk;
        if (raw.left >= pl)  { pl = raw.left;  al = 0; }
        else { al++; if (al > PEAK_HOLD_FRAMES) pl = Math.max(nl, pl - PEAK_DECAY_DB); }
        if (raw.right >= pr) { pr = raw.right; ar = 0; }
        else { ar++; if (ar > PEAK_HOLD_FRAMES) pr = Math.max(nr, pr - PEAK_DECAY_DB); }
        peakFxRtnRef.current[ch] = { pl, pr, al, ar };
        if (!prev || Math.abs(nl - prev.left) > 0.05 || Math.abs(nr - prev.right) > 0.05 ||
            Math.abs(pl - (prev.peakLeft ?? -90)) > 0.05 || Math.abs(pr - (prev.peakRight ?? -90)) > 0.05) {
          nextFxRtn[ch] = { left: nl, right: nr, peakLeft: pl, peakRight: pr };
          changed = true;
        }
      }

      if (changed) {
        smoothInputRef.current  = nextInput;
        smoothBusRef.current    = nextBus;
        smoothAuxInRef.current  = nextAuxIn;
        smoothFxRtnRef.current  = nextFxRtn;
        setInputVu(nextInput);
        setBusVu(nextBus);
        setAuxInVu(nextAuxIn);
        setFxRtnVu(nextFxRtn);
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Native path (Android APK — direct UDP OSC) ──────────────
  useEffect(() => {
    if (!IS_NATIVE) return;

    const listeners: Array<{ remove: () => void }> = [];

    const addL = async (event: string, cb: (d: any) => void) => {
      const h = await M32Native.addListener(event, cb);
      listeners.push(h);
    };

    (async () => {
      await addL('m32:status', (d: M32Status) => {
        setM32Status(d);
        if (d.status === 'disconnected' || d.status === 'error') {
          rawInputRef.current = {}; rawBusRef.current = {};
          rawAuxInRef.current = {}; rawFxRtnRef.current = {};
          smoothInputRef.current = {}; smoothBusRef.current = {};
          smoothAuxInRef.current = {}; smoothFxRtnRef.current = {};
          peakInputRef.current = {}; peakBusRef.current = {};
          peakAuxInRef.current = {}; peakFxRtnRef.current = {};
          setInputVu({}); setBusVu({}); setAuxInVu({}); setFxRtnVu({});
        }
      });
      await addL('m32:channelNames', (d: Record<string, string>) => setChannelNames(d));
      await addL('m32:busNames',     (d: Record<string, string>) => setBusNames(d));
      await addL('m32:busConfig',    (d: Record<string, { mono: boolean }>) => setBusConfig(d));
      await addL('m32:sendLevel', (d: { ch: string; bus: string; level: number; on: boolean }) => {
        setSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
      });
      await addL('m32:sendOn', (d: { ch: string; bus: string; level: number; on: boolean }) => {
        setSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
      });
      await addL('m32:sendPre', (d: { ch: string; bus: string; pre: boolean }) => {
        setSendPre(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: d.pre }));
      });
      await addL('m32:busLevel', (d: { bus: string; level: number; on: boolean }) => {
        setBusLevels(prev => ({ ...prev, [d.bus]: { level: d.level, on: d.on } }));
      });
      await addL('m32:busOn', (d: { bus: string; level: number; on: boolean }) => {
        setBusLevels(prev => ({ ...prev, [d.bus]: { level: d.level, on: d.on } }));
      });
      await addL('m32:inputMeters', (d: Record<string, { left: number; right: number }>) => {
        rawInputRef.current = { ...rawInputRef.current, ...d };
      });
      await addL('m32:busMeters', (d: Record<string, { left: number; right: number }>) => {
        rawBusRef.current = { ...rawBusRef.current, ...d };
      });
      await addL('m32:auxInMeters', (d: Record<string, { left: number; right: number }>) => {
        rawAuxInRef.current = { ...rawAuxInRef.current, ...d };
      });
      await addL('m32:fxRtnMeters', (d: Record<string, { left: number; right: number }>) => {
        rawFxRtnRef.current = { ...rawFxRtnRef.current, ...d };
      });
    })();

    return () => { listeners.forEach(l => l.remove()); };
  }, []);

  // ── Web/PWA path (Socket.io → server PC) ─────────────────
  useEffect(() => {
    if (IS_NATIVE || !socket) return;

    const onHandshake = (data: { m32Status?: M32Status }) => {
      if (data.m32Status) setM32Status(data.m32Status);
    };
    const onStatus = (d: M32Status) => {
      setM32Status(d);
      if (d.status === 'disconnected' || d.status === 'error') {
        rawInputRef.current  = {};
        rawBusRef.current    = {};
        rawAuxInRef.current  = {};
        rawFxRtnRef.current  = {};
        smoothInputRef.current  = {};
        smoothBusRef.current    = {};
        smoothAuxInRef.current  = {};
        smoothFxRtnRef.current  = {};
        peakInputRef.current    = {};
        peakBusRef.current      = {};
        peakAuxInRef.current    = {};
        peakFxRtnRef.current    = {};
        setInputVu({});
        setBusVu({});
        setAuxInVu({});
        setFxRtnVu({});
      }
    };
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
    const onAuxInNames  = (d: Record<string, string>) => setAuxInNames(d);
    const onFxRtnNames  = (d: Record<string, string>) => setFxRtnNames(d);
    const onAuxInSendLevel = (d: { ch: string; bus: string; level: number; on: boolean }) => {
      setAuxInSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
    };
    const onAuxInSendOn = (d: { ch: string; bus: string; level: number; on: boolean }) => {
      setAuxInSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
    };
    const onFxRtnSendLevel = (d: { ch: string; bus: string; level: number; on: boolean }) => {
      setFxRtnSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
    };
    const onFxRtnSendOn = (d: { ch: string; bus: string; level: number; on: boolean }) => {
      setFxRtnSendLevels(prev => ({ ...prev, [`${d.ch}:${d.bus}`]: { level: d.level, on: d.on } }));
    };
    const onAuxInMeters = (d: Record<string, { left: number; right: number }>) => {
      rawAuxInRef.current = { ...rawAuxInRef.current, ...d };
    };
    const onFxRtnMeters = (d: Record<string, { left: number; right: number }>) => {
      rawFxRtnRef.current = { ...rawFxRtnRef.current, ...d };
    };

    socket.on('server:handshake',    onHandshake);
    socket.on('m32:status',          onStatus);
    socket.on('m32:channelNames',    onChannelNames);
    socket.on('m32:busNames',        onBusNames);
    socket.on('m32:busConfig',       onBusConfig);
    socket.on('m32:sendLevel',       onSendLevel);
    socket.on('m32:sendOn',          onSendOn);
    socket.on('m32:busLevel',        onBusLevel);
    socket.on('m32:busOn',           onBusOn);
    socket.on('m32:inputMeters',     onInputMeters);
    socket.on('m32:busMeters',       onBusMeters);
    socket.on('m32:auxInNames',      onAuxInNames);
    socket.on('m32:fxRtnNames',      onFxRtnNames);
    socket.on('m32:auxInSendLevel',  onAuxInSendLevel);
    socket.on('m32:auxInSendOn',     onAuxInSendOn);
    socket.on('m32:fxRtnSendLevel',  onFxRtnSendLevel);
    socket.on('m32:fxRtnSendOn',     onFxRtnSendOn);
    socket.on('m32:auxInMeters',     onAuxInMeters);
    socket.on('m32:fxRtnMeters',     onFxRtnMeters);

    return () => {
      socket.off('server:handshake',   onHandshake);
      socket.off('m32:status',         onStatus);
      socket.off('m32:channelNames',   onChannelNames);
      socket.off('m32:busNames',       onBusNames);
      socket.off('m32:busConfig',      onBusConfig);
      socket.off('m32:sendLevel',      onSendLevel);
      socket.off('m32:sendOn',         onSendOn);
      socket.off('m32:busLevel',       onBusLevel);
      socket.off('m32:busOn',          onBusOn);
      socket.off('m32:inputMeters',    onInputMeters);
      socket.off('m32:busMeters',      onBusMeters);
      socket.off('m32:auxInNames',     onAuxInNames);
      socket.off('m32:fxRtnNames',     onFxRtnNames);
      socket.off('m32:auxInSendLevel', onAuxInSendLevel);
      socket.off('m32:auxInSendOn',    onAuxInSendOn);
      socket.off('m32:fxRtnSendLevel', onFxRtnSendLevel);
      socket.off('m32:fxRtnSendOn',    onFxRtnSendOn);
      socket.off('m32:auxInMeters',    onAuxInMeters);
      socket.off('m32:fxRtnMeters',    onFxRtnMeters);
    };
  }, [socket]);

  // ── Commands (dual-path) ──────────────────────────────────

  const connectM32 = useCallback((ip: string) => {
    if (IS_NATIVE) {
      M32Native.connect({ ip });
    } else {
      socket?.emit('m32:connect', { ip });
    }
  }, [socket]);

  const disconnectM32 = useCallback(() => {
    if (IS_NATIVE) {
      M32Native.disconnect();
    } else {
      socket?.emit('m32:disconnect');
    }
    setM32Status({ status: 'disconnected' });
  }, [socket]);

  const setChannelSendLevel = useCallback((ch: string, bus: string, level: number) => {
    if (IS_NATIVE) {
      M32Native.setChannelSendLevel({ ch, bus, level });
    } else {
      socket?.emit('m32:setChannelSendLevel', { ch, bus, level });
    }
    setSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], level },
    }));
  }, [socket]);

  const setChannelSendOn = useCallback((ch: string, bus: string, on: boolean) => {
    if (IS_NATIVE) {
      M32Native.setChannelSendOn({ ch, bus, on });
    } else {
      socket?.emit('m32:setChannelSendOn', { ch, bus, on });
    }
    setSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], on },
    }));
  }, [socket]);

  const setBusLevel = useCallback((bus: string, level: number) => {
    if (IS_NATIVE) {
      M32Native.setBusLevel({ bus, level });
    } else {
      socket?.emit('m32:setBusLevel', { bus, level });
    }
    setBusLevels(prev => ({
      ...prev,
      [bus]: { ...prev[bus], level },
    }));
  }, [socket]);

  const setBusOn = useCallback((bus: string, on: boolean) => {
    if (IS_NATIVE) {
      M32Native.setBusOn({ bus, on });
    } else {
      socket?.emit('m32:setBusOn', { bus, on });
    }
    setBusLevels(prev => ({
      ...prev,
      [bus]: { ...prev[bus], on },
    }));
  }, [socket]);

  const queryBus = useCallback((busNum: number) => {
    if (IS_NATIVE) {
      M32Native.queryBus({ bus: busNum });
    } else {
      socket?.emit('m32:queryBus', { bus: busNum });
    }
  }, [socket]);

  const setAuxInSendLevel = useCallback((ch: string, bus: string, level: number) => {
    socket?.emit('m32:setAuxInSendLevel', { ch, bus, level });
    setAuxInSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], level },
    }));
  }, [socket]);

  const setAuxInSendOn = useCallback((ch: string, bus: string, on: boolean) => {
    socket?.emit('m32:setAuxInSendOn', { ch, bus, on });
    setAuxInSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], on },
    }));
  }, [socket]);

  const setFxRtnSendLevel = useCallback((ch: string, bus: string, level: number) => {
    socket?.emit('m32:setFxRtnSendLevel', { ch, bus, level });
    setFxRtnSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], level },
    }));
  }, [socket]);

  const setFxRtnSendOn = useCallback((ch: string, bus: string, on: boolean) => {
    socket?.emit('m32:setFxRtnSendOn', { ch, bus, on });
    setFxRtnSendLevels(prev => ({
      ...prev,
      [`${ch}:${bus}`]: { ...prev[`${ch}:${bus}`], on },
    }));
  }, [socket]);

  return {
    m32Status,
    channelNames,
    busNames,
    busConfig,
    sendLevels,
    sendPre,
    busLevels,
    inputVu,
    busVu,
    auxInNames,
    fxRtnNames,
    auxInSendLevels,
    fxRtnSendLevels,
    auxInVu,
    fxRtnVu,
    connectM32,
    disconnectM32,
    setChannelSendLevel,
    setChannelSendOn,
    setBusLevel,
    setBusOn,
    queryBus,
    setAuxInSendLevel,
    setAuxInSendOn,
    setFxRtnSendLevel,
    setFxRtnSendOn,
  };
}
