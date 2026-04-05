/**
 * VideoSwitcher — ATEM Mini Pro video switching panel.
 * Single combined PGM/PVW source row (red=PGM, green=PVW).
 * Draggable T-bar (MetaController style), transition controls, DSK.
 */
'use client';

import React, { useCallback, useRef, useEffect, useState } from 'react';
import { VideoState, DSKState } from '@/hooks/useATEM';

// ── Source definitions ─────────────────────────────────────────

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

// ── Props ──────────────────────────────────────────────────────

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
  onSetProgramInput,
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

  const pgm = videoState?.programInput ?? -1;
  const pvw = videoState?.previewInput ?? -1;
  const style = videoState?.transitionStyle ?? 0;
  const inTransition = videoState?.transitionInProgress ?? false;
  const transitionPos = videoState?.transitionPosition ?? 0;
  const ftbBlack = videoState?.fadeToBlack?.isFullyBlack ?? false;
  const ftbTransitioning = videoState?.fadeToBlack?.inTransition ?? false;
  const disabled = !isConnected;

  return (
    <div className={`flex flex-col h-full overflow-y-auto bg-navy-950 select-none relative
                     ${!isConnected ? 'pointer-events-none' : ''}`}>

      {/* ── Disconnected overlay ─────────────────────────────── */}
      {!isConnected && (
        <div className="absolute inset-0 z-10 bg-navy-950/60 backdrop-blur-[1px]
                        flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-navy-500 uppercase tracking-widest font-semibold">
            Tidak terhubung ke ATEM
          </span>
        </div>
      )}

      {/* ── Single combined PGM/PVW source row ──────────────── */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex gap-1.5">
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
                  rounded-lg border py-3 gap-0.5 transition-all
                  font-black text-[11px] leading-tight
                  ${isPgm
                    ? 'bg-red-700 border-red-500 text-white shadow-lg shadow-red-900/50'
                    : isPvw
                      ? 'bg-green-700 border-green-500 text-white shadow-lg shadow-green-900/50'
                      : 'bg-navy-800 border-navy-700 text-navy-400 hover:bg-navy-700 hover:text-navy-200 hover:border-navy-500'
                  }
                  ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer active:scale-95'}
                `}
              >
                <span className="tracking-wide">{label}</span>
                <span className={`text-[8px] font-bold tracking-widest ${
                  isPgm ? 'text-red-300' : isPvw ? 'text-green-300' : 'text-navy-700'
                }`}>
                  {isPgm ? 'PGM' : isPvw ? 'PVW' : '···'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── T-Bar ────────────────────────────────────────────── */}
      <div className="px-3 pb-2">
        <TBar
          position={transitionPos}
          inTransition={inTransition}
          disabled={disabled}
          onSetPosition={onSetTransitionPosition}
          onTransitionComplete={onPerformCut}
        />
      </div>

      {/* ── Divider ─────────────────────────────────────────── */}
      <div className="mx-3 border-t border-navy-700/60" />

      {/* ── T-Style (col) + AUTO/CUT (flex-1) ───────────────── */}
      <div className="px-3 pt-3 pb-2 flex gap-3 items-end">
        {/* Transition style — vertical stack */}
        <div className="flex flex-col gap-1 shrink-0">
          <p className="text-[8px] text-navy-500 uppercase tracking-[0.2em] font-semibold">T-Style</p>
          <div className="flex flex-col gap-1">
            {TRANSITION_STYLES.map(ts => (
              <button
                key={ts.value}
                disabled={disabled}
                onClick={() => onSetTransitionStyle(ts.value)}
                className={`px-3 py-1.5 rounded text-[9px] font-bold tracking-widest uppercase transition-colors
                  ${style === ts.value
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/40'
                    : 'bg-navy-800 text-navy-400 hover:bg-navy-700 hover:text-navy-200'
                  }
                  ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {ts.label}
              </button>
            ))}
          </div>
        </div>

        {/* AUTO / CUT */}
        <div className="flex-1 flex flex-col gap-1">
          <p className="text-[8px] text-navy-500 uppercase tracking-[0.2em] font-semibold">Switch</p>
          <div className="flex gap-2 h-full">
            <button
              disabled={disabled}
              onClick={onPerformAuto}
              className={`flex-1 py-5 rounded-lg text-sm font-black tracking-[0.2em] uppercase transition-all
                ${inTransition
                  ? 'bg-amber-500 text-black animate-pulse shadow-lg shadow-amber-900/50'
                  : 'bg-green-700 text-white hover:bg-green-600 active:scale-95'
                }
                ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              AUTO
            </button>
            <button
              disabled={disabled}
              onClick={onPerformCut}
              className={`flex-1 py-5 rounded-lg text-sm font-black tracking-[0.2em] uppercase transition-all
                bg-red-700 text-white hover:bg-red-600 active:scale-95
                ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              CUT
            </button>
          </div>
        </div>
      </div>

      {/* ── Divider ─────────────────────────────────────────── */}
      <div className="mx-3 border-t border-navy-700/60" />

      {/* ── FTB + DSK row ───────────────────────────────────── */}
      <div className="px-3 pt-3 pb-4 flex gap-2 items-stretch">

        {/* FTB */}
        <button
          disabled={disabled}
          onClick={onPerformFTB}
          className={`flex-1 py-3 rounded-lg text-[10px] font-bold tracking-[0.12em] uppercase transition-all
            ${ftbBlack
              ? 'bg-gray-900 text-red-400 border border-red-700/60 shadow-inner'
              : ftbTransitioning
                ? 'bg-gray-800 text-amber-400 border border-amber-600/60 animate-pulse'
                : 'bg-navy-800 text-navy-300 hover:bg-navy-700 border border-navy-700'
            }
            ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          {ftbBlack ? '■ FTB ON' : 'FADE TO\nBLACK'}
        </button>

        {/* DSK 1 & 2 */}
        {[0, 1].map(i => {
          const dsk: DSKState | undefined = videoState?.dsk?.[i];
          const onAir = dsk?.onAir ?? false;
          const inTrans = dsk?.inTransition ?? false;
          const fillSrc = dsk?.fillSource ?? 0;
          const fillLabel = videoState?.inputLabels?.[String(fillSrc)]
            ?? (fillSrc === 3010 ? 'MP1' : fillSrc === 3020 ? 'MP2' : fillSrc > 0 ? `S${fillSrc}` : '—');

          return (
            <div key={i} className="flex flex-col gap-1 min-w-[52px]">
              <button
                disabled={disabled}
                onClick={() => onSetDSKOnAir(i, !onAir)}
                className={`flex flex-col items-center justify-center px-3 py-2 rounded-lg border transition-all
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
                className={`py-1 rounded text-[8px] font-bold tracking-widest uppercase
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
  );
}

// ── T-Bar component (see-saw / flip-flop) ────────────────────
// After each full transition: labels PGM↔PVW swap, thumb stays at extreme.
// Next drag goes the opposite direction.

interface TBarProps {
  position: number;        // 0–9999 from ATEM (used to mirror AUTO animation)
  inTransition: boolean;
  disabled: boolean;
  onSetPosition: (pos: number) => void;
  onTransitionComplete: () => void;
}

function TBar({ position, inTransition, disabled, onSetPosition, onTransitionComplete }: TBarProps) {
  const trackRef  = useRef<HTMLDivElement>(null);
  const dragging  = useRef(false);
  const flipped   = useRef(false);   // false = PGM left, true = PGM right
  const [thumbPct, setThumbPct] = useState(0);

  // Mirror ATEM AUTO transition position when not dragging
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
        // Forward complete — stay at RIGHT, flip labels
        onTransitionComplete();
        flipped.current = true;
        return 100;
      } else if (flipped.current && prev <= 2) {
        // Reverse complete — stay at LEFT, flip labels back
        onTransitionComplete();
        flipped.current = false;
        return 0;
      }
      return prev; // not at extreme — keep wherever released
    });
  };

  useEffect(() => {
    const onMouseMove  = (e: MouseEvent)  => onMove(e.clientX);
    const onTouchMove  = (e: TouchEvent)  => { e.preventDefault(); onMove(e.touches[0].clientX); };
    const onMouseUp    = () => onEnd();
    const onTouchEnd   = () => onEnd();

    window.addEventListener('mousemove',  onMouseMove);
    window.addEventListener('mouseup',    onMouseUp);
    window.addEventListener('touchmove',  onTouchMove, { passive: false });
    window.addEventListener('touchend',   onTouchEnd);
    return () => {
      window.removeEventListener('mousemove',  onMouseMove);
      window.removeEventListener('mouseup',    onMouseUp);
      window.removeEventListener('touchmove',  onTouchMove);
      window.removeEventListener('touchend',   onTouchEnd);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const isFlipped = flipped.current;
  const pct = thumbPct;

  // Fills: PGM side is always the "back" side (behind thumb)
  const pgmFillStyle = !isFlipped
    ? { left: 0, width: `${100 - pct}%`, background: 'linear-gradient(to right,rgba(185,28,28,.8),transparent)' }
    : { right: 0, width: `${100 - pct}%`, background: 'linear-gradient(to left,rgba(185,28,28,.8),transparent)' };

  const pvwFillStyle = !isFlipped
    ? { right: 0, width: `${pct}%`, background: 'linear-gradient(to left,rgba(21,128,61,.8),transparent)' }
    : { left: 0, width: `${pct}%`, background: 'linear-gradient(to right,rgba(21,128,61,.8),transparent)' };

  return (
    <div>
      {/* Labels — swap when flipped */}
      <div className="flex justify-between items-center mb-1">
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
        className={`relative h-12 rounded-lg border overflow-hidden
          ${inTransition ? 'border-amber-600/60' : 'border-navy-700'}
          ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}
          bg-navy-900`}
        onMouseDown={e => onStart(e.clientX)}
        onTouchStart={e => onStart(e.touches[0].clientX)}
      >
        {/* PGM fill */}
        <div className="absolute top-0 bottom-0 pointer-events-none" style={pgmFillStyle as React.CSSProperties} />
        {/* PVW fill */}
        <div className="absolute top-0 bottom-0 pointer-events-none" style={pvwFillStyle as React.CSSProperties} />
        {/* Thumb */}
        <div
          className="absolute top-1.5 bottom-1.5 w-5 -translate-x-1/2 rounded
            bg-navy-200 shadow-lg pointer-events-none
            flex flex-col items-center justify-center gap-1"
          style={{ left: `${pct}%` }}
        >
          <span className="w-3 h-px bg-navy-700 rounded-full" />
          <span className="w-3 h-px bg-navy-700 rounded-full" />
          <span className="w-3 h-px bg-navy-700 rounded-full" />
        </div>
      </div>
    </div>
  );
}

// ── Icon ───────────────────────────────────────────────────────

function SwitcherIcon() {
  return (
    <svg className="w-5 h-5 text-navy-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="4" width="16" height="12" rx="1.5" />
      <line x1="6" y1="4" x2="6" y2="16" />
      <line x1="10" y1="4" x2="10" y2="16" />
      <line x1="14" y1="4" x2="14" y2="16" />
    </svg>
  );
}
