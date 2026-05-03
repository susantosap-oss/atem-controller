/**
 * VUMeter — dual-bar (L/R) stereo level meter with peak hold.
 * Uses CSS transitions fed by RAF-smoothed values from useATEM.
 * Color: green (safe) → amber (warning -12dB) → red (clip 0dB+)
 */
'use client';

import React, { useMemo } from 'react';
import { LevelData, dbToVuHeight } from '@/lib/constants';

interface VUMeterProps {
  levels?: LevelData;
  height?: number; // px
  compact?: boolean;
}

const SEGMENTS = [
  { threshold: 0,    color: 'bg-red-500' },
  { threshold: -3,   color: 'bg-amber-400' },
  { threshold: -12,  color: 'bg-green-400' },
  { threshold: -60,  color: 'bg-green-600' },
];

function getBarColor(db: number): string {
  for (const seg of SEGMENTS) {
    if (db >= seg.threshold) return seg.color;
  }
  return 'bg-green-700';
}

function Bar({
  db,
  peakDb,
  barHeight,
}: {
  db: number;
  peakDb: number;
  barHeight: number;
}) {
  const fillPct  = Math.min(100, Math.max(0, dbToVuHeight(db) * 100));
  const peakPct  = Math.min(99.5, Math.max(0, dbToVuHeight(peakDb) * 100));
  const barColor = getBarColor(db);

  return (
    <div
      className="relative bg-navy-950 rounded-sm overflow-hidden"
      style={{ width: 8, height: barHeight }}
    >
      {/* Fill bar — bottom-up */}
      <div
        className={`absolute bottom-0 left-0 right-0 ${barColor} transition-all`}
        style={{
          height: `${fillPct}%`,
          transitionDuration: '33ms',
          transitionTimingFunction: 'linear',
        }}
      />
      {/* Peak hold indicator */}
      <div
        className="absolute left-0 right-0 h-px bg-white opacity-80"
        style={{
          bottom: `${peakPct}%`,
          transitionDuration: '150ms',
          transitionTimingFunction: 'ease-out',
          transition: 'bottom 150ms ease-out',
        }}
      />
    </div>
  );
}

export default function VUMeter({ levels, height = 120, compact = false }: VUMeterProps) {
  const l  = levels?.left     ?? -60;
  const r  = levels?.right    ?? -60;
  const pl = levels?.peakLeft  ?? l;
  const pr = levels?.peakRight ?? r;

  // dB scale marks on the right (only for full size)
  const scaleMarks = useMemo(() => {
    if (compact) return [];
    return [-60, -40, -20, -12, -6, -3, 0];
  }, [compact]);

  return (
    <div className="flex items-stretch gap-0.5" style={{ height }}>
      {/* L bar */}
      <Bar db={l} peakDb={pl} barHeight={height} />
      {/* R bar */}
      <Bar db={r} peakDb={pr} barHeight={height} />

      {/* dB scale */}
      {!compact && (
        <div
          className="relative ml-1"
          style={{ height, width: 20 }}
        >
          {scaleMarks.map((mark) => {
            const pct = (1 - dbToVuHeight(mark)) * 100;
            return (
              <div
                key={mark}
                className="absolute right-0 text-[9px] text-navy-500 leading-none"
                style={{ top: `${pct}%`, transform: 'translateY(-50%)' }}
              >
                {mark === -60 ? '-∞' : mark === 0 ? '0' : mark}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
