/**
 * MediaPlayer — ATEM Mini Pro Media Pool controller.
 * Shows MP1/MP2 status + 20 still slots. Tap slot to assign to MP1 or MP2.
 * ATEM Mini Pro: 2 media players, 20 still slots, no clip support.
 */
'use client';

import React from 'react';
import { MediaState } from '@/hooks/useATEM';

interface MediaPlayerProps {
  mediaState: MediaState | null;
  isConnected: boolean;
  onSetMediaPlayerStill: (playerIndex: number, stillIndex: number) => void;
}

const STILL_SLOTS = 20;

// ── Media Player status card ───────────────────────────────────

function MPCard({
  label,
  playerIndex,
  mediaState,
}: {
  label: string;
  playerIndex: number;
  mediaState: MediaState | null;
}) {
  const player   = mediaState?.players?.[playerIndex];
  const slotIdx  = player?.stillIndex ?? -1;
  const still    = mediaState?.stillPool?.[slotIdx];
  const fileName = still?.fileName?.replace(/\.[^.]+$/, '') || '—';
  const slotNum  = still?.isUsed ? `Slot ${slotIdx + 1}` : '';

  return (
    <div className="flex-1 bg-navy-800/60 border border-navy-700/60 rounded-lg px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_5px_#f59e0b]" />
        <span className="text-[11px] font-bold text-amber-300 uppercase tracking-widest">
          {label}
        </span>
        {slotNum && (
          <span className="ml-auto text-[10px] text-navy-500">{slotNum}</span>
        )}
      </div>
      <div
        className="text-xs font-mono text-navy-200 truncate"
        title={still?.fileName || ''}
      >
        {still?.isUsed ? fileName : <span className="text-navy-600 italic">Empty</span>}
      </div>
    </div>
  );
}

// ── Still slot card ────────────────────────────────────────────

function StillSlotCard({
  slotIndex,
  mediaState,
  onAssign,
}: {
  slotIndex: number;
  mediaState: MediaState | null;
  onAssign: (playerIndex: number) => void;
}) {
  const still     = mediaState?.stillPool?.[slotIndex];
  const isUsed    = still?.isUsed ?? false;
  const fileName  = still?.fileName ?? '';
  const shortName = fileName.replace(/\.[^.]+$/, '') || '—';

  const mp1Active = mediaState?.players?.[0]?.stillIndex === slotIndex &&
                    mediaState?.players?.[0]?.sourceType === 1;
  const mp2Active = mediaState?.players?.[1]?.stillIndex === slotIndex &&
                    mediaState?.players?.[1]?.sourceType === 1;

  const slotLabel = String(slotIndex + 1).padStart(2, '0');

  return (
    <div
      className={`flex flex-col rounded-lg border transition-colors
        ${isUsed
          ? 'bg-navy-800/80 border-navy-600/60 hover:border-navy-500/80'
          : 'bg-navy-900/40 border-navy-800/40'
        }
        ${mp1Active || mp2Active ? 'ring-1 ring-amber-500/60' : ''}`}
      style={{ padding: '6px 7px' }}
    >
      {/* Slot number + active badges */}
      <div className="flex items-center gap-1 mb-1">
        <span className={`text-[10px] font-mono font-bold
          ${isUsed ? 'text-navy-400' : 'text-navy-700'}`}>
          {slotLabel}
        </span>
        {mp1Active && (
          <span className="text-[8px] font-bold bg-amber-500 text-black px-1 rounded leading-tight">
            MP1
          </span>
        )}
        {mp2Active && (
          <span className="text-[8px] font-bold bg-blue-500 text-white px-1 rounded leading-tight">
            MP2
          </span>
        )}
      </div>

      {/* Filename */}
      <div
        className={`text-[9px] font-mono leading-tight truncate mb-1.5
          ${isUsed ? 'text-navy-200' : 'text-navy-700 italic'}`}
        title={fileName}
        style={{ maxWidth: '100%' }}
      >
        {isUsed ? shortName : 'empty'}
      </div>

      {/* Assign buttons — only for used slots */}
      <div className="flex gap-1 mt-auto">
        <button
          onClick={() => isUsed && onAssign(0)}
          disabled={!isUsed}
          className={`flex-1 text-[9px] font-bold py-0.5 rounded transition-colors
            ${mp1Active
              ? 'bg-amber-500 text-black'
              : isUsed
              ? 'bg-navy-700 text-amber-400 hover:bg-amber-900/60'
              : 'bg-navy-900 text-navy-700 cursor-not-allowed'}`}
        >
          MP1
        </button>
        <button
          onClick={() => isUsed && onAssign(1)}
          disabled={!isUsed}
          className={`flex-1 text-[9px] font-bold py-0.5 rounded transition-colors
            ${mp2Active
              ? 'bg-blue-500 text-white'
              : isUsed
              ? 'bg-navy-700 text-blue-400 hover:bg-blue-900/60'
              : 'bg-navy-900 text-navy-700 cursor-not-allowed'}`}
        >
          MP2
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────

export default function MediaPlayer({
  mediaState,
  isConnected,
  onSetMediaPlayerStill,
}: MediaPlayerProps) {

  const usedCount = mediaState
    ? Object.values(mediaState.stillPool).filter(s => s.isUsed).length
    : 0;

  return (
    <div className="flex flex-col h-full bg-navy-950">

      {/* Header */}
      <div className="flex items-center px-4 py-2 bg-navy-900
                      border-b border-navy-700/70 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {[0,1,2].map(i => (
              <div key={i} className="w-1 h-5 rounded-sm bg-amber-600 opacity-80" />
            ))}
          </div>
          <span className="text-sm font-bold tracking-wide text-navy-100">
            MEDIA POOL
          </span>
        </div>
        <div className="ml-auto text-[11px] text-navy-500">
          {mediaState ? `${usedCount} / ${STILL_SLOTS} slots used` : 'No data'}
        </div>
      </div>

      {/* ── Always show grid — greyed when disconnected ────── */}
      <div className={`flex flex-col flex-1 overflow-hidden relative
                       ${!isConnected ? 'pointer-events-none' : ''}`}>

        {/* Grey overlay when disconnected */}
        {!isConnected && (
          <div className="absolute inset-0 z-10 bg-navy-950/60 backdrop-blur-[1px]
                          flex items-center justify-center pointer-events-none">
            <span className="text-[10px] text-navy-500 uppercase tracking-widest font-semibold">
              Tidak terhubung ke ATEM
            </span>
          </div>
        )}

        {/* MP1 / MP2 status row */}
        <div className="flex gap-2 px-3 py-2 shrink-0 border-b border-navy-800/60">
          <MPCard label="Media Player 1" playerIndex={0} mediaState={mediaState} />
          <MPCard label="Media Player 2" playerIndex={1} mediaState={mediaState} />
        </div>

        {/* Still pool grid — scrollable */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="text-[10px] text-navy-600 uppercase tracking-widest mb-2 px-0.5">
            Still Pool — tap a slot to assign
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {Array.from({ length: STILL_SLOTS }, (_, i) => (
              <StillSlotCard
                key={i}
                slotIndex={i}
                mediaState={mediaState}
                onAssign={(playerIndex) => onSetMediaPlayerStill(playerIndex, i)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center px-4 py-1.5 bg-navy-950
                      border-t border-navy-800/60 shrink-0">
        <span className="text-[10px] text-navy-600">
          ATEM MINI PRO — 2 Media Players · 20 Still Slots
        </span>
        <div className="ml-auto text-[10px] text-navy-600">
          Tap MP1 / MP2 to assign · active slot highlighted
        </div>
      </div>
    </div>
  );
}
