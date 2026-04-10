/**
 * VideoSwitcher — ATEM Mini Pro video switching panel.
 * Layout landscape-optimized:
 *   Header: [icon] ATEM SWITCHER
 *   Row 1:  PGM/PVW source buttons
 *   Row 2:  [T-Bar 30%] [AUTO / CUT — same height as FTB] [T-Style]
 *   Row 3:  [FTB 30% = same width as T-Bar] [spacer] [DSK1] [DSK2]
 */
'use client';

import React, { useCallback, useRef, useEffect, useState } from 'react';
import { VideoState, DSKState } from '@/hooks/useATEM';

const SOURCES = [
  { id: 1,    shortLabel: '1',   defaultLabel: 'CH 1' },
  { id: 2,    shortLabel: '2',   defaultLabel: 'CH 2' },
  { id: 3,    shortLabel: '3',   defaultLabel: 'CH 3' },
  { id: 4,    shortLabel: '4',   defaultLabel: 'CH 4' },
  { id: 3010, shortLabel: 'MP1', defaultLabel: 'MP 1' },
  { id: 3020, shortLabel: 'MP2', defaultLabel: 'MP 2' },
  { id: 0,    shortLabel: 'BLK', defaultLabel: 'BLK'  },
];

const TRANSITION_STYLES = [
  { value: 0, label: 'MIX'  },
  { value: 1, label: 'DIP'  },
  { value: 2, label: 'WIPE' },
];

interface Props {
  videoState: VideoState | null;
  isConnected: boolean;
  onSetPreviewInput: (source: number) => void;
  onSetProgramInput: (source: number) => void;
  onPerformAuto: () => void;
  onPerformCut: () => void;
  onSetTransitionStyle: (style: number) => void;
  onSetTransitionPosition: (position: number) => void;
  onPerformFTB: () => void;
  onSetDSKOnAir: (keyerIndex: number, onAir: boolean) => void;
  onAutoDSKTransition: (keyerIndex: number) => void;
}

export default function VideoSwitcher({
  videoState,
  isConnected,
  onSetPreviewInput,
  onSetProgramInput: _onSetProgramInput,
  onPerformAuto,
  onPerformCut,
  onSetTransitionStyle,
  onSetTransitionPosition,
  onPerformFTB,
  onSetDSKOnAir,
  onAutoDSKTransition,
}: Props) {

  const getShortLabel = useCallback((sourceId: number) => {
    const src = SOURCES.find(s => s.id === sourceId);
    if (!src) return `${sourceId}`;
    const custom = videoState?.inputLabels?.[String(sourceId)];
    if (custom && custom !== src.defaultLabel) {
      return custom.length > 5 ? custom.slice(0, 5) : custom;
    }
    return src.shortLabel;
  }, [videoState]);

  const getFullLabel = useCallback((sourceId: number) => {
    const src = SOURCES.find(s => s.id === sourceId);
    if (!src) return `${sourceId}`;
    return videoState?.inputLabels?.[String(sourceId)] ?? src.defaultLabel;
  }, [videoState]);

  const pgm            = videoState?.programInput     ?? -1;
  const pvw            = videoState?.previewInput     ?? -1;
  const style          = videoState?.transitionStyle  ?? 0;
  const inTransition   = videoState?.transitionInProgress ?? false;
  const transitionPos  = videoState?.transitionPosition   ?? 0;
  const ftbBlack       = videoState?.fadeToBlack?.isFullyBlack ?? false;
  const ftbTransiting  = videoState?.fadeToBlack?.inTransition ?? false;
  const disabled       = !isConnected;

  return (
    <div className={`flex flex-col h-full bg-navy-950 select-none relative
                     ${!isConnected ? 'pointer-events-none' : ''}`}>

      {/* ── Disconnected overlay ───────────────────────────────── */}
      {!isConnected && (
        <div className="absolute inset-0 z-10 bg-navy-950/60 backdrop-blur-[1px]
                        flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-navy-500 uppercase tracking-widest font-semibold">
            Tidak terhubung ke ATEM
          </span>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          HEADER — ATEM SWITCHER
          ════════════════════════════════════════════════════════ */}
      <div className="flex items-center px-4 py-2 bg-navy-900 border-b border-navy-700/70 shrink-0">
        <div className="flex items-center gap-2">
          {/* Icon: stacked video layers */}
          <div className="flex flex-col gap-[2px]">
            {[0, 1, 2].map(i => (
              <div key={i} className={`rounded-sm ${i === 0 ? 'w-5 h-1' : i === 1 ? 'w-4 h-1' : 'w-3 h-1'}`}
                style={{ background: i === 0 ? '#ef4444' : i === 1 ? '#22c55e' : '#3b82f6', opacity: 0.85 }} />
            ))}
          </div>
          <span className="text-sm font-bold tracking-wide text-navy-100">
            ATEM SWITCHER
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className={`text-[10px] font-semibold tracking-widest uppercase
            ${inTransition ? 'text-amber-400 animate-pulse' : 'text-navy-600'}`}>
            {inTransition ? '● TRANSITIONING' : '○ READY'}
          </span>
          {ftbBlack && (
            <span className="text-[10px] font-bold text-red-400 tracking-widest uppercase">
              ■ FTB
            </span>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════
          ROW 1 — PGM / PVW source buttons
          ════════════════════════════════════════════════════════ */}
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex gap-2">
          {SOURCES.map(src => {
            const isPgm = pgm === src.id;
            const isPvw = pvw === src.id;
            const label = getShortLabel(src.id);

            return (
              <button
                key={src.id}
                disabled={disabled}
                title={getFullLabel(src.id)}
                onClick={() => onSetPreviewInput(src.id)}
                className={`
                  flex-1 flex flex-col items-center justify-center
                  rounded-xl border py-4 gap-1.5 transition-all
                  font-black leading-tight
                  ${isPgm
                    ? 'bg-red-700 border-red-500 text-white shadow-lg shadow-red-900/50'
                    : isPvw
                      ? 'bg-green-700 border-green-500 text-white shadow-lg shadow-green-900/50'
                      : 'bg-navy-800 border-navy-700 text-navy-300 hover:bg-navy-700 hover:text-white hover:border-navy-500'
                  }
                  ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer active:scale-95'}
                `}
              >
                <span className="tracking-wide text-lg">{label}</span>
                <span className={`text-[10px] font-bold tracking-widest ${
                  isPgm ? 'text-red-300' : isPvw ? 'text-green-300' : 'text-navy-600'
                }`}>
                  {isPgm ? 'PGM' : isPvw ? 'PVW' : '···'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 mx-3 border-t border-navy-700/50" />

      {/* ════════════════════════════════════════════════════════
          CONTROL AREA — flex-1: 3 kolom vertikal penuh sampai nav bar
          Kiri(30%): T-Bar atas + FTB bawah
          Tengah(30%): AUTO(flex-1) + CUT(flex-1)
          Kanan(flex-1): T-Style atas + DSK bawah
          ════════════════════════════════════════════════════════ */}
      <div className="flex-1 min-h-0 px-3 pt-3 pb-4 flex gap-3">

        {/* ── Kolom KIRI 30%: T-Bar (flex-1) + FTB (shrink-0) ── */}
        <div className="flex flex-col flex-1 gap-2">
          <p className="text-[8px] text-navy-500 uppercase tracking-[0.18em] font-semibold shrink-0">
            T-Bar
          </p>
          <div className="flex-1 min-h-0">
            <TBar
              position={transitionPos}
              inTransition={inTransition}
              disabled={disabled}
              onSetPosition={onSetTransitionPosition}
              onTransitionComplete={onPerformCut}
            />
          </div>
          {/* FTB — di bawah T-Bar, lebar penuh kolom (30%) */}
          <button
            disabled={disabled}
            onClick={onPerformFTB}
            className={`shrink-0 py-3 rounded-xl text-[11px] font-bold tracking-[0.12em] uppercase transition-all
              ${ftbBlack
                ? 'bg-gray-900 text-red-400 border border-red-700/60 shadow-inner'
                : ftbTransiting
                  ? 'bg-gray-800 text-amber-400 border border-amber-600/60 animate-pulse'
                  : 'bg-navy-800 text-navy-300 hover:bg-navy-700 border border-navy-700'
              }
              ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            {ftbBlack ? '■ FTB ON' : 'FADE TO BLACK'}
          </button>
        </div>

        {/* ── Kolom TENGAH 30%: AUTO + CUT mengisi penuh sampai nav bar ── */}
        <div className="flex flex-col flex-1 gap-2">
          <p className="text-[8px] text-navy-500 uppercase tracking-[0.18em] font-semibold shrink-0">
            Switch
          </p>
          <button
            disabled={disabled}
            onClick={onPerformAuto}
            className={`flex-1 rounded-xl text-xl font-black tracking-[0.2em] uppercase transition-all
              ${inTransition
                ? 'bg-amber-500 text-black animate-pulse shadow-lg shadow-amber-900/50'
                : 'bg-navy-800 border border-navy-700 text-navy-300 hover:bg-navy-700 hover:text-white hover:border-navy-500 active:scale-95'
              }
              ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            AUTO
          </button>
          <button
            disabled={disabled}
            onClick={onPerformCut}
            className={`flex-1 rounded-xl text-xl font-black tracking-[0.2em] uppercase transition-all
              bg-navy-800 border border-navy-700 text-navy-300 hover:bg-navy-700 hover:text-white hover:border-navy-500 active:scale-95
              ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            CUT
          </button>
        </div>

        {/* ── Kolom KANAN flex-1: T-Style atas + DSK bawah ── */}
        <div className="flex flex-col flex-1 gap-1">
          <p className="text-[8px] text-navy-500 uppercase tracking-[0.18em] font-semibold shrink-0">
            T-Style
          </p>
          {/* T-Style buttons */}
          {TRANSITION_STYLES.map(ts => (
            <button
              key={ts.value}
              disabled={disabled}
              onClick={() => onSetTransitionStyle(ts.value)}
              className={`flex-1 px-3 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-colors
                ${style === ts.value
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/40'
                  : 'bg-navy-800 text-navy-400 hover:bg-navy-700 hover:text-navy-200'
                }
                ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {ts.label}
            </button>
          ))}

          {/* Spacer antara T-Style dan DSK */}
          <div className="flex-1" />

          {/* DSK 1 & 2 */}
          <div className="flex gap-2 shrink-0">
            {[0, 1].map(i => {
              const dsk: DSKState | undefined = videoState?.dsk?.[i];
              const onAir   = dsk?.onAir       ?? false;
              const inTrans = dsk?.inTransition ?? false;
              const fillSrc = dsk?.fillSource   ?? 0;
              const fillLabel = videoState?.inputLabels?.[String(fillSrc)]
                ?? (fillSrc === 3010 ? 'MP1' : fillSrc === 3020 ? 'MP2' : fillSrc > 0 ? `S${fillSrc}` : '—');

              return (
                <div key={i} className="flex flex-col gap-1 flex-1">
                  <button
                    disabled={disabled}
                    onClick={() => onSetDSKOnAir(i, !onAir)}
                    className={`flex flex-col items-center justify-center px-2 py-2 rounded-xl border transition-all
                      ${onAir
                        ? 'bg-red-700 border-red-500 text-white shadow-md shadow-red-900/50'
                        : inTrans
                          ? 'bg-amber-700/60 border-amber-500/60 text-amber-300 animate-pulse'
                          : 'bg-navy-800 border-navy-700 text-navy-400 hover:border-navy-500 hover:text-navy-200'
                      }
                      ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer active:scale-95'}
                    `}
                  >
                    <span className="text-[10px] font-black tracking-widest">DSK{i + 1}</span>
                    <span className={`text-[8px] font-semibold ${onAir ? 'text-red-200' : 'text-navy-600'}`}>
                      {onAir ? '● ON' : '○ OFF'}
                    </span>
                    {fillSrc > 0 && (
                      <span className={`text-[7px] font-mono ${onAir ? 'text-red-300' : 'text-navy-700'}`}>
                        {fillLabel}
                      </span>
                    )}
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => onAutoDSKTransition(i)}
                    className={`py-1 rounded-lg text-[8px] font-bold tracking-widest uppercase
                      bg-navy-800 border border-navy-700 text-navy-500
                      hover:text-navy-300 hover:border-navy-600 transition-colors
                      ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    AUTO
                  </button>
                </div>
              );
            })}
          </div>
        </div>

      </div>

    </div>
  );
}

// ── T-Bar component ───────────────────────────────────────────
// Horizontal slider dengan thumb berbentuk pegangan tuas fisik.
// Flip-flop setelah mencapai ujung.

interface TBarProps {
  position: number;
  inTransition: boolean;
  disabled: boolean;
  onSetPosition: (pos: number) => void;
  onTransitionComplete: () => void;
}

function TBar({ position, inTransition, disabled, onSetPosition, onTransitionComplete }: TBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const flipped  = useRef(false);
  const [thumbPct, setThumbPct] = useState(0);

  useEffect(() => {
    if (dragging.current) return;
    if (inTransition) {
      const pct = (position / 9999) * 100;
      setThumbPct(flipped.current ? 100 - pct : pct);
    }
  }, [position, inTransition]);

  const getPct = (clientX: number): number => {
    if (!trackRef.current) return thumbPct;
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  };

  const onStart = (clientX: number) => {
    if (disabled) return;
    dragging.current = true;
    const pct = getPct(clientX);
    setThumbPct(pct);
    onSetPosition(Math.round((flipped.current ? 1 - pct / 100 : pct / 100) * 9999));
  };

  const onMove = (clientX: number) => {
    if (!dragging.current) return;
    const pct = getPct(clientX);
    setThumbPct(pct);
    onSetPosition(Math.round((flipped.current ? 1 - pct / 100 : pct / 100) * 9999));
  };

  const onEnd = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setThumbPct(prev => {
      if (!flipped.current && prev >= 98) {
        onTransitionComplete();
        flipped.current = true;
        return 100;
      } else if (flipped.current && prev <= 2) {
        onTransitionComplete();
        flipped.current = false;
        return 0;
      }
      return prev;
    });
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX);
    const onTouchMove = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX); };
    window.addEventListener('mousemove',  onMouseMove);
    window.addEventListener('mouseup',    onEnd);
    window.addEventListener('touchmove',  onTouchMove, { passive: false });
    window.addEventListener('touchend',   onEnd);
    return () => {
      window.removeEventListener('mousemove',  onMouseMove);
      window.removeEventListener('mouseup',    onEnd);
      window.removeEventListener('touchmove',  onTouchMove);
      window.removeEventListener('touchend',   onEnd);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const isFlipped = flipped.current;
  const pct = thumbPct;

  const pgmFill = !isFlipped
    ? { left: 0, width: `${100 - pct}%`, background: 'linear-gradient(to right,rgba(185,28,28,.7),transparent)' }
    : { right: 0, width: `${100 - pct}%`, background: 'linear-gradient(to left,rgba(185,28,28,.7),transparent)' };

  const pvwFill = !isFlipped
    ? { right: 0, width: `${pct}%`, background: 'linear-gradient(to left,rgba(21,128,61,.7),transparent)' }
    : { left: 0, width: `${pct}%`, background: 'linear-gradient(to right,rgba(21,128,61,.7),transparent)' };

  return (
    <div className="flex flex-col h-full">
      {/* Labels */}
      <div className="flex justify-between items-center mb-1.5">
        <span className={`text-[9px] font-bold uppercase tracking-[0.15em] ${isFlipped ? 'text-green-400' : 'text-red-400'}`}>
          {isFlipped ? 'PVW' : 'PGM'}
        </span>
        <span className="text-[9px] font-mono text-navy-500">{Math.round(pct)}%</span>
        <span className={`text-[9px] font-bold uppercase tracking-[0.15em] ${isFlipped ? 'text-red-400' : 'text-green-400'}`}>
          {isFlipped ? 'PGM' : 'PVW'}
        </span>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        className={`flex-1 relative rounded-xl border overflow-hidden min-h-[44px]
          ${inTransition ? 'border-amber-600/60' : 'border-navy-600'}
          ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}
          bg-navy-900`}
        onMouseDown={e => onStart(e.clientX)}
        onTouchStart={e => onStart(e.touches[0].clientX)}
      >
        {/* PGM / PVW fill */}
        <div className="absolute top-0 bottom-0 pointer-events-none" style={pgmFill as React.CSSProperties} />
        <div className="absolute top-0 bottom-0 pointer-events-none" style={pvwFill as React.CSSProperties} />

        {/* ── Pegangan Tuas (lever handle) ── */}
        <div
          className="absolute top-[6px] bottom-[6px] w-10 -translate-x-1/2 rounded-xl pointer-events-none overflow-hidden"
          style={{
            left: `${pct}%`,
            background: 'linear-gradient(180deg, #c8d6e5 0%, #94a3b8 25%, #6b8299 60%, #4a6075 100%)',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 4px 12px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.35)',
          }}
        >
          {/* Top shine */}
          <div
            className="absolute inset-x-0 top-0 h-[40%] rounded-t-xl pointer-events-none"
            style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, transparent 100%)' }}
          />
          {/* Grip grooves */}
          <div className="absolute inset-x-[6px] top-1/2 -translate-y-1/2 flex flex-col gap-[4px]">
            {[0, 1, 2, 3, 4].map(i => (
              <div
                key={i}
                className="rounded-full"
                style={{
                  height: '1.5px',
                  background: 'linear-gradient(90deg, rgba(0,0,0,0.5) 0%, rgba(255,255,255,0.1) 50%, rgba(0,0,0,0.5) 100%)',
                }}
              />
            ))}
          </div>
          {/* Center position marker */}
          <div
            className="absolute left-1/2 top-1 bottom-1 w-px -translate-x-1/2 pointer-events-none"
            style={{ background: 'rgba(255,255,255,0.15)' }}
          />
        </div>
      </div>
    </div>
  );
}
