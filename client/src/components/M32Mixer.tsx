/**
 * M32Mixer — Midas M32R Live MixBus controller.
 *
 * Layout:
 *   Header  : IP input + Connect/Disconnect button + status dot
 *   Bus bar : 16 toggle buttons (multi-select), default Bus 7 & 8
 *   Content : horizontal-scroll channel strips + fixed bus master columns
 *
 * Each channel strip (width scales with selected bus count):
 *   - Channel name (readonly from M32)
 *   - Compact VU meter (from M32 input meters)
 *   - Per selected bus: vertical send fader + ON button + dB readout
 *
 * Right side — one bus master column per selected bus:
 *   - Bus name + MONO/STEREO badge
 *   - Bus VU meter
 *   - Bus master fader + ON button + dB readout
 */

'use client';

import React, {
  useState, useRef, useCallback, useEffect, useMemo,
} from 'react';
import VUMeter from './VUMeter';
import { LevelData } from '@/lib/constants';
import {
  M32Status, M32SendEntry, M32BusEntry,
} from '@/hooks/useM32';

// ── M32 level curve (raw 0–1 ↔ dBu) ─────────────────────────
// Breakpoints: 0.00→-90, 0.25→-40, 0.50→-20, 0.75→0dB, 1.00→+10
const CURVE: [number, number][] = [
  [0.00, -90], [0.25, -40], [0.50, -20], [0.75, 0], [1.00, 10],
];

function m32ToDb(v: number): number {
  if (v <= 0) return -90;
  if (v >= 1) return 10;
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [x0, y0] = CURVE[i], [x1, y1] = CURVE[i + 1];
    if (v >= x0 && v <= x1) {
      const t = (v - x0) / (x1 - x0);
      return Math.round((y0 + t * (y1 - y0)) * 10) / 10;
    }
  }
  return -90;
}

function fmtDb(v: number): string {
  if (v <= -90) return '-∞';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

// ── Props ─────────────────────────────────────────────────────

interface M32MixerProps {
  m32Status:      M32Status;
  channelNames:   Record<string, string>;
  busNames:       Record<string, string>;
  busConfig:      Record<string, { mono: boolean }>;
  channelOn:      Record<string, boolean>;
  dcaNames:       Record<string, string>;
  dcaOn:          Record<string, boolean>;
  sendLevels:     Record<string, M32SendEntry>;
  sendPre:        Record<string, boolean>;
  busLevels:      Record<string, M32BusEntry>;
  inputVu:        Record<string, LevelData>;
  busVu:          Record<string, LevelData>;
  auxInNames:     Record<string, string>;
  fxRtnNames:     Record<string, string>;
  auxInSendLevels: Record<string, M32SendEntry>;
  fxRtnSendLevels: Record<string, M32SendEntry>;
  auxInVu:        Record<string, LevelData>;
  fxRtnVu:        Record<string, LevelData>;
  serverConnected: boolean;
  onConnect:      (ip: string) => void;
  onDisconnect:   () => void;
  onChannelOn:         (ch: string, on: boolean) => void;
  onDcaOn:             (dca: string, on: boolean) => void;
  onChannelSendLevel:  (ch: string, bus: string, level: number) => void;
  onChannelSendOn:     (ch: string, bus: string, on: boolean) => void;
  onBusLevel:     (bus: string, level: number) => void;
  onBusOn:        (bus: string, on: boolean) => void;
  onQueryBus:     (busNum: number) => void;
  onAuxInSendLevel:    (ch: string, bus: string, level: number) => void;
  onAuxInSendOn:       (ch: string, bus: string, on: boolean) => void;
  onFxRtnSendLevel:    (ch: string, bus: string, level: number) => void;
  onFxRtnSendOn:       (ch: string, bus: string, on: boolean) => void;
}

// ── Constants ─────────────────────────────────────────────────

const FADER_H     = 120;  // px — send fader track height
const BUS_FADER_H = 120;  // px — bus master fader height (same as send fader)
const LS_KEY      = 'm32ip';
const LS_BUSES    = 'm32buses';
const LS_LINKED   = 'm32linked'; // manually configured linked (stereo) bus pairs: odd bus numbers

const DEFAULT_BUSES = new Set([5, 6]);
const CH_KEYS     = Array.from({ length: 32 }, (_, i) => String(i + 1).padStart(2, '0'));
const AUXIN_KEYS  = Array.from({ length:  8 }, (_, i) => String(i + 1).padStart(2, '0'));
const FXRTN_KEYS  = Array.from({ length:  4 }, (_, i) => String(i + 1).padStart(2, '0'));
const DCA_KEYS    = Array.from({ length:  8 }, (_, i) => String(i + 1).padStart(2, '0'));
const BUS_NUMS = Array.from({ length: 16 }, (_, i) => i + 1);

// ── Send fader (compact vertical, one per bus) ────────────────

function SendFader({
  ch, bus, entry, disabled, isPre,
  onChange, onToggle,
}: {
  ch: string; bus: string;
  entry: M32SendEntry;
  disabled: boolean;
  isPre?: boolean;
  onChange: (ch: string, bus: string, v: number) => void;
  onToggle: (ch: string, bus: string, on: boolean) => void;
}) {
  const dragging  = useRef(false);
  const startY    = useRef(0);
  const startVal  = useRef(entry.level);
  const thumbTop  = (1 - entry.level) * 100;
  const db        = m32ToDb(entry.level);

  const onPtrDown = useCallback((e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    startY.current   = e.clientY;
    startVal.current = entry.level;
  }, [disabled, entry.level]);

  const onPtrMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const deltaY = startY.current - e.clientY;
    const next   = Math.min(1, Math.max(0, startVal.current + deltaY / FADER_H));
    onChange(ch, bus, Math.round(next * 1000) / 1000);
  }, [ch, bus, onChange]);

  const onPtrUp = useCallback(() => { dragging.current = false; }, []);

  // Double-tap → unity (0.75)
  const lastTap = useRef(0);
  const onTap = useCallback(() => {
    if (disabled) return;
    const now = Date.now();
    if (now - lastTap.current < 300) onChange(ch, bus, 0.75);
    lastTap.current = now;
  }, [ch, bus, disabled, onChange]);

  const isOn = entry.on;

  return (
    <div className="flex flex-col items-center gap-0.5" style={{ width: 34 }}>
      {/* Fader track */}
      <div
        className="relative bg-navy-950 rounded border border-navy-700/60"
        style={{ width: 22, height: FADER_H }}
        onPointerDown={onPtrDown}
        onPointerMove={onPtrMove}
        onPointerUp={onPtrUp}
        onClick={onTap}
      >
        {/* Unity line (0.75 = 0dB) */}
        <div
          className="absolute left-0 right-0 border-t border-dashed border-navy-500/50"
          style={{ top: `${(1 - 0.75) * 100}%` }}
        />
        {/* Thumb */}
        <div
          className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm z-10
            cursor-grab active:cursor-grabbing border shadow
            ${disabled ? 'bg-navy-700 border-navy-600' : isOn ? 'bg-blue-500 border-blue-400' : 'bg-navy-600 border-navy-500'}`}
          style={{
            top:    `${thumbTop}%`,
            width:  18,
            height: 8,
          }}
          title={`${fmtDb(db)} dB — double-tap: unity`}
        >
          <div className="absolute inset-x-0.5 top-1/2 -translate-y-1/2 flex flex-col gap-px">
            {[0,1].map(i => <div key={i} className="h-px bg-white/25" />)}
          </div>
        </div>
      </div>

      {/* dB readout */}
      <div className={`text-[8px] font-mono text-center leading-tight
        ${db > 0 ? 'text-amber-400' : db > -6 ? 'text-green-400' : 'text-navy-500'}`}
        style={{ minWidth: 30 }}>
        {fmtDb(db)}
      </div>

      {/* ON button */}
      <button
        disabled={disabled}
        onClick={() => !disabled && onToggle(ch, bus, !isOn)}
        className={`text-[8px] font-bold rounded py-0.5 w-full transition-colors
          ${isOn
            ? 'bg-green-600 text-white shadow-[0_0_4px_#16a34a]'
            : 'bg-navy-800 text-navy-500'}`}
      >
        {isOn ? 'ON' : 'OFF'}
      </button>

      {/* PRE / POST routing badge */}
      {isPre !== undefined && (
        <div className={`text-[7px] font-bold rounded py-0.5 text-center w-full leading-tight
          ${isPre
            ? 'bg-amber-900/70 text-amber-400 border border-amber-700/50'
            : 'bg-navy-800/50 text-navy-600 border border-navy-700/30'}`}
        >
          {isPre ? 'PRE' : 'POST'}
        </div>
      )}
    </div>
  );
}

// ── Channel strip ─────────────────────────────────────────────

function M32ChannelStrip({
  chKey, name, selectedBuses, channelOn, sendLevels, sendPre, vu, disabled,
  onChannelOn, onSendLevel, onSendOn,
}: {
  chKey:         string;
  name:          string;
  selectedBuses: number[];
  channelOn?:    boolean;
  sendLevels:    Record<string, M32SendEntry>;
  sendPre:       Record<string, boolean>;
  vu?:           LevelData;
  disabled:      boolean;
  onChannelOn?:  (ch: string, on: boolean) => void;
  onSendLevel:   (ch: string, bus: string, v: number) => void;
  onSendOn:      (ch: string, bus: string, on: boolean) => void;
}) {
  const numBuses = selectedBuses.length;
  const totalW   = 20 + numBuses * 36;   // VU(20) + per-bus(36)
  const isMuted  = channelOn === false;  // undefined = belum diketahui dari device

  return (
    <div
      className="flex flex-col border-r border-navy-800/70 bg-navy-900/40"
      style={{ width: totalW, padding: '6px 4px' }}
    >
      {/* Name */}
      <div className="w-full text-center mb-1">
        <span
          className="text-[9px] font-semibold tracking-wide uppercase truncate block
                     px-0.5 py-0.5 rounded text-navy-300 bg-navy-800/60"
          title={name}
        >
          {name}
        </span>
      </div>

      {/* Channel master mute (mirrors physical ON button on M32 console) */}
      {onChannelOn && (
        <button
          disabled={disabled}
          onClick={() => !disabled && onChannelOn(chKey, isMuted)}
          title="Channel master ON/MUTE (mirrors device console)"
          className={`text-[8px] font-bold rounded py-0.5 w-full mb-1 transition-colors
            ${disabled
              ? 'bg-navy-800 text-navy-600'
              : isMuted
                ? 'bg-red-600 text-white shadow-[0_0_4px_#dc2626]'
                : 'bg-navy-800 text-green-400 border border-green-700/40'}`}
        >
          {isMuted ? 'MUTED' : 'ON'}
        </button>
      )}

      {/* VU + faders side-by-side */}
      <div className="flex items-end gap-1">
        {/* Compact VU meter */}
        <VUMeter levels={vu} height={FADER_H + 22} compact />

        {/* Send faders (one per selected bus) */}
        {selectedBuses.map((busNum) => {
          const busKey = String(busNum).padStart(2, '0');
          const entry  = sendLevels[`${chKey}:${busKey}`] ?? { level: 0.75, on: true };
          const isPre  = sendPre[`${chKey}:${busKey}`];
          return (
            <SendFader
              key={busNum}
              ch={chKey}
              bus={busKey}
              entry={entry}
              disabled={disabled}
              isPre={isPre}
              onChange={onSendLevel}
              onToggle={onSendOn}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Bus master fader ──────────────────────────────────────────

function BusMasterStrip({
  busKey, name, mono, entry, vu, disabled, onLevel, onOn,
}: {
  busKey:   string;
  name:     string;
  mono:     boolean;
  entry:    M32BusEntry;
  vu?:      LevelData;
  disabled: boolean;
  onLevel:  (bus: string, v: number) => void;
  onOn:     (bus: string, on: boolean) => void;
}) {
  const dragging  = useRef(false);
  const startY    = useRef(0);
  const startVal  = useRef(entry.level);
  const trackRef  = useRef<HTMLDivElement>(null);
  const trackH    = useRef(BUS_FADER_H);
  const [measuredH, setMeasuredH] = useState(BUS_FADER_H);

  const thumbTop  = (1 - entry.level) * 100;
  const db        = m32ToDb(entry.level);
  const isOn      = entry.on;

  // Track fader height dynamically so drag sensitivity and VU always match available space
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      const h = e.contentRect.height;
      trackH.current = h;
      setMeasuredH(h);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const onPtrDown = useCallback((e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    startY.current   = e.clientY;
    startVal.current = entry.level;
  }, [disabled, entry.level]);

  const onPtrMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const deltaY = startY.current - e.clientY;
    const next   = Math.min(1, Math.max(0, startVal.current + deltaY / trackH.current));
    onLevel(busKey, Math.round(next * 1000) / 1000);
  }, [busKey, onLevel]);

  const onPtrUp = useCallback(() => { dragging.current = false; }, []);

  const lastTap = useRef(0);
  const onTap = useCallback(() => {
    if (disabled) return;
    const now = Date.now();
    if (now - lastTap.current < 300) onLevel(busKey, 0.75);
    lastTap.current = now;
  }, [busKey, disabled, onLevel]);

  return (
    <div className="flex flex-col gap-1 h-full select-none overflow-hidden"
         style={{ width: 60, padding: '3px 3px' }}>

      {/* Name + badge — satu baris */}
      <div className="flex items-center gap-1 w-full shrink-0">
        <span
          className="flex-1 text-[8px] font-bold tracking-wide text-center truncate
                     text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded px-1 py-0.5"
          title={name}
        >
          {name || `Bus ${parseInt(busKey)}`}
        </span>
        <span className={`text-[7px] font-bold uppercase rounded px-0.5 py-0.5 shrink-0
          ${mono
            ? 'bg-navy-900/60 text-navy-300 border border-navy-700/50'
            : 'bg-blue-900/60 text-blue-300 border border-blue-700/50'}`}>
          {mono ? 'M' : 'S'}
        </span>
      </div>

      {/* VU + Fader — flex-1 mengisi sisa ruang yang tersedia */}
      <div className="flex items-stretch gap-1 flex-1 min-h-0">
        <VUMeter levels={vu} height={measuredH} compact />
        <div
          ref={trackRef}
          className="relative bg-navy-950 rounded border border-navy-700/60 flex-1"
          onPointerDown={onPtrDown}
          onPointerMove={onPtrMove}
          onPointerUp={onPtrUp}
          onClick={onTap}
        >
          {/* Unity (0.75) */}
          <div
            className="absolute left-0 right-0 border-t border-dashed border-amber-700/50"
            style={{ top: `${(1 - 0.75) * 100}%` }}
          />
          {/* Thumb */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm z-10
              cursor-grab active:cursor-grabbing border shadow
              ${disabled ? 'bg-navy-700 border-navy-600' : isOn ? 'bg-amber-500 border-amber-400' : 'bg-navy-600 border-navy-500'}`}
            style={{ top: `${thumbTop}%`, width: 22, height: 8 }}
            title={`${fmtDb(db)} dB — double-tap: unity`}
          >
            <div className="absolute inset-x-1 top-1/2 -translate-y-1/2 flex flex-col gap-[2px]">
              {[0,1,2].map(i => <div key={i} className="h-px bg-white/25" />)}
            </div>
          </div>
        </div>
      </div>

      {/* dB + ON/OFF — satu baris di bawah */}
      <div className="flex items-center gap-1 w-full shrink-0">
        <div className={`flex-1 text-[8px] font-mono font-semibold text-center py-0.5 px-0.5
          rounded bg-navy-950 border border-navy-700/40
          ${db > 0 ? 'text-amber-400' : db > -6 ? 'text-green-400' : 'text-navy-400'}`}>
          {fmtDb(db)}
        </div>
        <button
          disabled={disabled}
          onClick={() => !disabled && onOn(busKey, !isOn)}
          className={`text-[8px] font-bold px-1.5 py-0.5 rounded transition-colors shrink-0
            ${isOn
              ? 'bg-green-600 text-white shadow-[0_0_5px_#16a34a]'
              : 'bg-navy-800 text-navy-500'}`}
        >
          {isOn ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────

export default function M32Mixer({
  m32Status,
  channelNames,
  busNames,
  busConfig,
  channelOn,
  dcaNames,
  dcaOn,
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
  serverConnected,
  onConnect,
  onDisconnect,
  onChannelOn,
  onDcaOn,
  onChannelSendLevel,
  onChannelSendOn,
  onBusLevel,
  onBusOn,
  onQueryBus,
  onAuxInSendLevel,
  onAuxInSendOn,
  onFxRtnSendLevel,
  onFxRtnSendOn,
}: M32MixerProps) {

  // ── IP persistence ────────────────────────────────────────
  const [m32IP, setM32IP] = useState<string>(() =>
    (typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY)) || ''
  );
  const [ipInput, setIpInput] = useState(m32IP);

  // ── Manual linked-pair override (odd bus number = left of pair) ─
  // M32R doesn't respond to /bus/NN/config/ms queries — set manually here.
  // Merged with busConfig from device: device wins if it ever pushes.
  const [manualLinked, setManualLinked] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem(LS_LINKED);
      if (saved) return new Set(JSON.parse(saved) as number[]);
    } catch {}
    return new Set<number>();
  });

  const toggleManualLink = useCallback((n1: number) => {
    setManualLinked(prev => {
      const next = new Set(prev);
      if (next.has(n1)) next.delete(n1); else next.add(n1);
      try { localStorage.setItem(LS_LINKED, JSON.stringify(Array.from(next))); } catch {}
      return next;
    });
  }, []);

  // Effective link status: device busConfig OR manual override
  const isLinkedPair = useCallback((n1: number): boolean => {
    const k1 = String(n1).padStart(2, '0');
    if (busConfig[k1] !== undefined) return !busConfig[k1].mono;
    return manualLinked.has(n1);
  }, [busConfig, manualLinked]);

  // ── Bus selection ─────────────────────────────────────────
  const [selectedBuses, setSelectedBuses] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem(LS_BUSES);
      if (saved) {
        const arr = JSON.parse(saved) as number[];
        if (Array.isArray(arr) && arr.length > 0) return new Set(arr);
      }
    } catch {}
    return DEFAULT_BUSES;
  });

  const sortedBuses = useMemo(
    () => Array.from(selectedBuses).sort((a, b) => a - b),
    [selectedBuses]
  );

  // Non-linked bus: exclusive single-select (replaces entire selection)
  const toggleBus = useCallback((n: number) => {
    setSelectedBuses(() => {
      const next = new Set([n]);
      try { localStorage.setItem(LS_BUSES, JSON.stringify([n])); } catch {}
      return next;
    });
  }, []);

  // Linked pair: select the pair exclusively (replaces entire selection)
  const toggleLinkedPair = useCallback((n1: number, n2: number) => {
    setSelectedBuses(() => {
      const next = new Set([n1, n2]);
      try { localStorage.setItem(LS_BUSES, JSON.stringify([n1, n2])); } catch {}
      return next;
    });
  }, []);

  // Query M32 for send levels when bus selection changes
  useEffect(() => {
    if (m32Status.status === 'connected') {
      selectedBuses.forEach(b => onQueryBus(b));
    }
  }, [selectedBuses, m32Status.status, onQueryBus]);

  // ── Connect / disconnect ──────────────────────────────────
  const handleConnect = useCallback(() => {
    const ip = ipInput.trim();
    if (!ip) return;
    localStorage.setItem(LS_KEY, ip);
    setM32IP(ip);
    onConnect(ip);
  }, [ipInput, onConnect]);

  const handleDisconnect = useCallback(() => {
    onDisconnect();
  }, [onDisconnect]);

  const isConnected  = m32Status.status === 'connected';
  const isConnecting = m32Status.status === 'connecting';
  const hasIP        = ipInput.trim().length > 0;
  const disabled     = !isConnected;

  // ── Link edit mode ────────────────────────────────────────
  const [linkEditMode, setLinkEditMode] = useState(false);

  // ── Bus selector label ─────────────────────────────────────
  const busLabel = (n: number) => {
    const key = String(n).padStart(2, '0');
    return busNames[key] || `${n}`;
  };

  // ── Status dot ────────────────────────────────────────────
  const statusDot = {
    connected:    'bg-green-500 shadow-[0_0_6px_#22c55e]',
    connecting:   'bg-amber-400 animate-pulse',
    disconnected: 'bg-navy-600',
    error:        'bg-red-500',
  }[m32Status.status];

  return (
    <div className="flex flex-col h-full bg-navy-950">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-navy-900
                      border-b border-navy-700/70 shrink-0">
        {/* Logo / title */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex gap-0.5">
            {[0,1,2].map(i => (
              <div key={i} className="w-1 h-5 rounded-sm"
                   style={{ background: ['#a4bcfd','#6172f3','#3e46d0'][i] }} />
            ))}
          </div>
          <span className="text-sm font-bold tracking-wide text-navy-200">
            MIDAS M32R LIVE
          </span>
        </div>

        {/* IP input */}
        <input
          type="text"
          value={ipInput}
          onChange={e => setIpInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConnect()}
          placeholder="IP Address M32 (e.g. 192.168.1.10)"
          className="flex-1 min-w-0 bg-navy-800 border border-navy-600/60 rounded px-2 py-1
                     text-[11px] text-navy-100 placeholder-navy-600
                     focus:outline-none focus:border-navy-500"
        />

        {/* Connect / Disconnect button */}
        {isConnected ? (
          <button
            onClick={handleDisconnect}
            className="shrink-0 px-2 py-1 rounded text-[10px] font-bold
                       bg-red-700/80 text-white border border-red-600/60
                       hover:bg-red-600 transition-colors"
          >
            DISCONNECT
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!hasIP || isConnecting}
            className="shrink-0 px-2 py-1 rounded text-[10px] font-bold transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed
                       bg-navy-700 text-white border border-navy-500/60
                       hover:bg-navy-600"
          >
            {isConnecting ? 'CONNECTING…' : 'CONNECT'}
          </button>
        )}

        {/* Status dot */}
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusDot}`} />
      </div>

      {/* ── Server not connected notice ──────────────────── */}
      {!serverConnected && (
        <div className="px-3 py-1.5 bg-amber-950/40 border-b border-amber-800/50 shrink-0">
          <span className="text-[10px] text-amber-400/80 uppercase tracking-widest">
            ⚠ M32 memerlukan koneksi ke Server PC — hubungkan server terlebih dahulu
          </span>
        </div>
      )}

      {/* ── Bus selector ───────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-navy-900/60
                      border-b border-navy-700/50 shrink-0">
        <span className="text-[9px] text-navy-600 uppercase tracking-widest shrink-0 mr-1">
          MixBus
        </span>

        {/* Scrollable bus buttons — LNK button stays outside */}
        <div className="flex items-center gap-1 flex-1 overflow-x-auto min-w-0">
        {Array.from({ length: 8 }, (_, i) => {
          const n1 = i * 2 + 1;
          const n2 = n1 + 1;
          const linked = isLinkedPair(n1);

          if (linkEditMode) {
            return (
              <button
                key={n1}
                onClick={() => toggleManualLink(n1)}
                className={`shrink-0 rounded text-[9px] font-bold transition-colors
                  h-6 px-1.5 border flex items-center gap-0.5
                  ${linked
                    ? 'bg-blue-700 text-white border-blue-400'
                    : 'bg-navy-800 text-navy-500 border-navy-600 border-dashed'}`}
              >
                <span>{n1}</span>
                <span className="text-[8px]">{linked ? '⬡' : '·'}</span>
                <span>{n2}</span>
              </button>
            );
          }

          if (linked) {
            const bothActive = selectedBuses.has(n1) && selectedBuses.has(n2);
            return (
              <button
                key={n1}
                onClick={() => toggleLinkedPair(n1, n2)}
                className={`shrink-0 rounded text-[9px] font-bold transition-colors
                  h-6 px-1.5 border flex items-center gap-0.5
                  ${bothActive
                    ? 'bg-blue-700 text-white border-blue-500 shadow-[0_0_4px_#1d4ed8]'
                    : 'bg-navy-800 text-navy-400 border-blue-800/50'}`}
              >
                <span>{n1}</span>
                <span className="text-[6px] opacity-60">⬡</span>
                <span>{n2}</span>
              </button>
            );
          }

          return (
            <React.Fragment key={n1}>
              {[n1, n2].map(n => (
                <button
                  key={n}
                  onClick={() => toggleBus(n)}
                  className={`shrink-0 rounded text-[9px] font-bold transition-colors
                    w-6 h-6 border
                    ${selectedBuses.has(n)
                      ? 'bg-navy-700 text-white border-navy-500 shadow-[0_0_4px_#3e46d0]'
                      : 'bg-navy-800 text-navy-500 border-navy-700 hover:text-navy-300'}`}
                >
                  {n}
                </button>
              ))}
            </React.Fragment>
          );
        })}

          {!linkEditMode && (
            <span className="text-[9px] text-navy-400 ml-1 shrink-0">
              {sortedBuses.map(n => busLabel(n)).join(' + ')}
            </span>
          )}
          {linkEditMode && (
            <span className="text-[9px] text-blue-400 ml-1 shrink-0 italic">
              tap = toggle link
            </span>
          )}
        </div>{/* end scrollable */}

        {/* LNK button — fixed, always visible */}
        <button
          onClick={() => setLinkEditMode(p => !p)}
          className={`shrink-0 ml-1 rounded text-[9px] font-bold px-1.5 h-6 border transition-colors
            ${linkEditMode
              ? 'bg-blue-700 text-white border-blue-400'
              : 'bg-navy-800 text-navy-600 border-navy-700'}`}
        >
          {linkEditMode ? 'DONE' : 'LNK'}
        </button>
      </div>

      {/* ── DCA group mute row ─────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-navy-900/60
                      border-b border-navy-700/50 shrink-0 overflow-x-auto">
        <span className="text-[9px] text-navy-600 uppercase tracking-widest shrink-0 mr-1">
          DCA
        </span>
        {DCA_KEYS.map(dcaKey => {
          const on     = dcaOn[dcaKey];
          const muted  = on === false;
          const name   = dcaNames[dcaKey] || `DCA ${parseInt(dcaKey)}`;
          return (
            <button
              key={dcaKey}
              disabled={disabled}
              onClick={() => !disabled && onDcaOn(dcaKey, muted)}
              title={`${name} — klik untuk ${muted ? 'aktifkan' : 'mute'} (mirrors device console)`}
              className={`shrink-0 rounded text-[9px] font-bold px-1.5 h-6 border transition-colors
                truncate max-w-[72px]
                ${disabled
                  ? 'bg-navy-800 text-navy-600 border-navy-700'
                  : muted
                    ? 'bg-red-600 text-white border-red-400 shadow-[0_0_4px_#dc2626]'
                    : 'bg-navy-800 text-green-400 border-green-700/40'}`}
            >
              {name}
            </button>
          );
        })}
      </div>

      {/* ── Mixer area ─────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Disabled overlay — shown when disconnected OR no IP */}
        {(!isConnected) && (
          <div className="absolute inset-0 z-50 bg-navy-950/70 backdrop-blur-[1px]
                          flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <span className="text-[11px] text-navy-500 uppercase tracking-widest font-semibold block">
                {!hasIP
                  ? 'Masukkan IP Address M32 untuk memulai'
                  : isConnecting
                    ? 'Menghubungkan ke M32…'
                    : 'Tidak terhubung ke Midas M32R Live'}
              </span>
              {m32Status.error && (
                <span className="text-[10px] text-red-400 block mt-1">{m32Status.error}</span>
              )}
            </div>
          </div>
        )}

        {/* Channel strips — horizontal scroll */}
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex items-stretch h-full gap-px min-w-max">

            {/* Section label */}
            <div className="flex flex-col justify-center px-1.5 py-3 shrink-0">
              <span className="text-[9px] text-navy-600 uppercase tracking-widest"
                    style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                Input Channels
              </span>
            </div>

            {/* Input channel strips (CH 1-32) */}
            <div className="flex h-full">
              {CH_KEYS.map(chKey => (
                <M32ChannelStrip
                  key={chKey}
                  chKey={chKey}
                  name={channelNames[chKey] || `CH ${parseInt(chKey)}`}
                  selectedBuses={sortedBuses}
                  channelOn={channelOn[chKey]}
                  sendLevels={sendLevels}
                  sendPre={sendPre}
                  vu={inputVu[chKey]}
                  disabled={disabled}
                  onChannelOn={onChannelOn}
                  onSendLevel={onChannelSendLevel}
                  onSendOn={onChannelSendOn}
                />
              ))}
            </div>

            {/* Divider + AuxIn label */}
            <div className="flex flex-col justify-center px-1.5 py-3 shrink-0
                            border-l-2 border-navy-600/60">
              <span className="text-[9px] text-blue-500 uppercase tracking-widest"
                    style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                Aux In
              </span>
            </div>

            {/* AuxIn strips (AuxIn 1-8) */}
            <div className="flex h-full">
              {AUXIN_KEYS.map(chKey => (
                <M32ChannelStrip
                  key={`auxin-${chKey}`}
                  chKey={chKey}
                  name={auxInNames[chKey] || `AuxIn ${parseInt(chKey)}`}
                  selectedBuses={sortedBuses}
                  sendLevels={auxInSendLevels}
                  sendPre={{}}
                  vu={auxInVu[chKey]}
                  disabled={disabled}
                  onSendLevel={onAuxInSendLevel}
                  onSendOn={onAuxInSendOn}
                />
              ))}
            </div>

            {/* Divider + FxRtn label */}
            <div className="flex flex-col justify-center px-1.5 py-3 shrink-0
                            border-l-2 border-navy-600/60">
              <span className="text-[9px] text-amber-500 uppercase tracking-widest"
                    style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                Fx Rtn
              </span>
            </div>

            {/* FxRtn strips (FxRtn 1-4) */}
            <div className="flex h-full">
              {FXRTN_KEYS.map(chKey => (
                <M32ChannelStrip
                  key={`fxrtn-${chKey}`}
                  chKey={chKey}
                  name={fxRtnNames[chKey] || `FxRtn ${parseInt(chKey)}`}
                  selectedBuses={sortedBuses}
                  sendLevels={fxRtnSendLevels}
                  sendPre={{}}
                  vu={fxRtnVu[chKey]}
                  disabled={disabled}
                  onSendLevel={onFxRtnSendLevel}
                  onSendOn={onFxRtnSendOn}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Bus master strips — fixed right, one per selected bus */}
        {sortedBuses.length > 0 && (
          <div className="flex border-l-2 border-navy-700/60 bg-navy-900/10
                          shrink-0 overflow-x-auto overflow-y-hidden h-full gap-px">
            {sortedBuses.map(busNum => {
              const busKey = String(busNum).padStart(2, '0');
              const entry  = busLevels[busKey] ?? { level: 0.75, on: true };
              const cfg    = busConfig[busKey]  ?? { mono: false };
              return (
                <BusMasterStrip
                  key={busNum}
                  busKey={busKey}
                  name={busNames[busKey] || `Bus ${busNum}`}
                  mono={cfg.mono}
                  entry={entry}
                  vu={busVu[busKey]}
                  disabled={disabled}
                  onLevel={onBusLevel}
                  onOn={onBusOn}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Status bar ─────────────────────────────────────── */}
      <div className="flex items-center px-4 py-1 bg-navy-950
                      border-t border-navy-800/60 shrink-0 gap-4">
        <span className="text-[9px] text-navy-600">
          MIDAS M32R LIVE — MIXBUS CONTROLLER
        </span>
        <div className="ml-auto flex gap-4 text-[9px] text-navy-600">
          <span>Fader: drag · double-tap = 0 dB</span>
          <span>Bus: {sortedBuses.map(n => `MX${n}`).join(', ')}</span>
        </div>
      </div>
    </div>
  );
}
