/**
 * MediaPlayer — ATEM Mini Pro overlay controller.
 * Workflow: pilih still → load ke MP1 → DSK1 tampil di stream.
 * Hanya menampilkan slot yang terisi (isUsed), bukan 20 slot kosong.
 */
'use client';

import React from 'react';
import { MediaState, VideoState } from '@/hooks/useATEM';

interface Props {
  mediaState:          MediaState | null;
  videoState:          VideoState | null;
  isConnected:         boolean;
  onSetMediaPlayerStill: (playerIndex: number, stillIndex: number) => void;
  onSetDSKOnAir:       (keyerIndex: number, onAir: boolean) => void;
}

export default function MediaPlayer({
  mediaState,
  videoState,
  isConnected,
  onSetMediaPlayerStill,
  onSetDSKOnAir,
}: Props) {

  // Slot yang benar-benar terisi
  const usedSlots = Object.entries(mediaState?.stillPool ?? {})
    .filter(([, s]) => s.isUsed)
    .map(([idx, s]) => ({ index: Number(idx), fileName: s.fileName ?? '' }))
    .sort((a, b) => a.index - b.index);

  // MP1 state
  const mp1Player   = mediaState?.players?.[0];
  const mp1StillIdx = mp1Player?.stillIndex ?? -1;
  const mp1Still    = mediaState?.stillPool?.[mp1StillIdx];
  const mp1Name     = mp1Still?.fileName?.replace(/\.[^.]+$/, '') ?? '—';

  // DSK1 state (index 0)
  const dsk1OnAir  = videoState?.dsk?.[0]?.onAir      ?? false;
  const dsk1InTrans = videoState?.dsk?.[0]?.inTransition ?? false;

  const disabled = !isConnected;

  const handleStillTap = (slotIndex: number) => {
    if (disabled) return;
    // Load ke MP1
    onSetMediaPlayerStill(0, slotIndex);
    // Jika DSK1 sudah ON, biarkan tetap ON (still baru otomatis tampil)
    // Jika DSK1 OFF, nyalakan otomatis
    if (!dsk1OnAir) {
      onSetDSKOnAir(0, true);
    }
  };

  return (
    <div className="flex flex-col h-full bg-navy-950 select-none relative">

      {/* ── Disconnected overlay ─────────────────────────── */}
      {!isConnected && (
        <div className="absolute inset-0 z-10 bg-navy-950/60 backdrop-blur-[1px]
                        flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-navy-500 uppercase tracking-widest font-semibold">
            Tidak terhubung ke ATEM
          </span>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-center px-4 py-2 bg-navy-900 border-b border-navy-700/70 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex gap-[2px]">
            {[0,1,2].map(i => (
              <div key={i} className="w-1 h-5 rounded-sm bg-amber-600 opacity-80" />
            ))}
          </div>
          <span className="text-sm font-bold tracking-wide text-navy-100">MEDIA POOL</span>
        </div>
        <div className="ml-auto text-[11px] text-navy-500">
          {usedSlots.length} overlay tersedia
        </div>
      </div>

      {/* ── Status bar: MP1 aktif + DSK1 toggle ─────────── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2
                      bg-navy-900/60 border-b border-navy-800/60">

        {/* MP1 status */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${
            dsk1OnAir ? 'bg-red-500 shadow-[0_0_6px_#ef4444]' : 'bg-navy-600'
          }`} />
          <span className="text-[10px] text-navy-500 uppercase tracking-widest shrink-0">MP1</span>
          <span className="text-[11px] font-mono text-navy-200 truncate">{mp1Name}</span>
        </div>

        {/* DSK1 toggle button */}
        <button
          disabled={disabled}
          onClick={() => onSetDSKOnAir(0, !dsk1OnAir)}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-[11px] font-bold
            tracking-widest uppercase transition-all shrink-0
            ${dsk1OnAir
              ? 'bg-red-700 border border-red-500 text-white shadow-lg shadow-red-900/40'
              : dsk1InTrans
                ? 'bg-amber-700/60 border border-amber-500/60 text-amber-300 animate-pulse'
                : 'bg-navy-800 border border-navy-700 text-navy-400 hover:border-navy-500 hover:text-navy-200'
            }
            ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer active:scale-95'}
          `}
        >
          <span className={`text-[9px] ${dsk1OnAir ? 'text-red-300' : 'text-navy-600'}`}>
            {dsk1OnAir ? '●' : '○'}
          </span>
          DSK1 {dsk1OnAir ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* ── Still grid — hanya slot terisi ──────────────── */}
      <div className={`flex-1 overflow-y-auto px-3 py-3
                       ${disabled ? 'pointer-events-none' : ''}`}>

        {usedSlots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-[11px] text-navy-600 uppercase tracking-widest">
              Belum ada media di pool
            </span>
            <span className="text-[10px] text-navy-700">
              Upload via ATEM Software Control
            </span>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
            {usedSlots.map(({ index, fileName }) => {
              const shortName = fileName.replace(/\.[^.]+$/, '') || `Slot ${index + 1}`;
              const isInMp1  = mp1Player?.sourceType === 1 && mp1StillIdx === index;
              const isLive   = isInMp1 && dsk1OnAir;

              return (
                <button
                  key={index}
                  onClick={() => handleStillTap(index)}
                  disabled={disabled}
                  className={`flex flex-col items-start gap-2 p-3 rounded-xl border text-left
                    transition-all active:scale-95
                    ${isLive
                      ? 'bg-red-900/40 border-red-600/60 shadow-lg shadow-red-900/30'
                      : isInMp1
                        ? 'bg-amber-900/30 border-amber-600/50'
                        : 'bg-navy-800/80 border-navy-700/60 hover:border-navy-500/80 hover:bg-navy-700/60'
                    }
                    ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  {/* Preview placeholder — garis seperti slide thumbnail */}
                  <div className={`w-full rounded-md overflow-hidden border
                    ${isLive ? 'border-red-600/40' : isInMp1 ? 'border-amber-600/40' : 'border-navy-700/40'}`}
                    style={{ aspectRatio: '16/9', background: '#0a1628' }}
                  >
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 opacity-40">
                      {[0,1,2].map(i => (
                        <div key={i} className={`rounded-full h-px ${i === 1 ? 'w-8' : 'w-5'} bg-navy-400`} />
                      ))}
                    </div>
                  </div>

                  {/* Nama file */}
                  <span className={`text-[11px] font-mono font-semibold leading-tight truncate w-full
                    ${isLive ? 'text-red-200' : isInMp1 ? 'text-amber-200' : 'text-navy-200'}`}
                    title={fileName}
                  >
                    {shortName}
                  </span>

                  {/* Badge status */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-navy-600 font-mono">
                      #{String(index + 1).padStart(2, '0')}
                    </span>
                    {isLive && (
                      <span className="text-[8px] font-bold bg-red-600 text-white px-1.5 py-px rounded
                                       tracking-widest animate-pulse">
                        ● LIVE
                      </span>
                    )}
                    {isInMp1 && !isLive && (
                      <span className="text-[8px] font-bold bg-amber-600 text-black px-1.5 py-px rounded
                                       tracking-widest">
                        MP1
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Bottom hint ──────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between px-4 py-1.5
                      bg-navy-950 border-t border-navy-800/60">
        <span className="text-[10px] text-navy-700">
          Tap still → load MP1 + DSK1 ON otomatis
        </span>
        <span className={`text-[10px] font-semibold uppercase tracking-widest
          ${dsk1OnAir ? 'text-red-500' : 'text-navy-700'}`}>
          {dsk1OnAir ? '● Overlay ON' : '○ Overlay OFF'}
        </span>
      </div>

    </div>
  );
}
