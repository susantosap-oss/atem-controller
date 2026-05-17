/**
 * AudioChannel — one vertical channel strip, Fairlight style.
 * Contains: label, VU meter, vertical fader, dB readout, pan knob, ON/AFV/OFF buttons.
 */
'use client';

import React, { useCallback, useRef } from 'react';
import VUMeter from './VUMeter';
import type { ChannelState, LevelData } from '@/hooks/useATEM';
import {
  MixOption,
  type MixOptionValue,
  dbToFaderPos,
  faderPosToDb,
  formatDb,
  FADER_MIN_DB,
  FADER_MAX_DB,
} from '@/lib/constants';

interface AudioChannelProps {
  index: string | number;
  channel: ChannelState;
  levels?: LevelData;
  isMaster?: boolean;
  onGainChange: (index: string | number, gain: number) => void;
  onMixOptionChange: (index: string | number, mixOption: MixOptionValue) => void;
  onBalanceChange?: (index: string | number, balance: number) => void;
}

const FADER_HEIGHT = 110; // px — track height (compact to fit ON/AFV/OFF on small screens)
const PAN_WIDTH    = 52;  // px — pan drag width

export default function AudioChannel({
  index,
  channel,
  levels,
  isMaster = false,
  onGainChange,
  onMixOptionChange,
  onBalanceChange,
}: AudioChannelProps) {
  const { gain, balance, mixOption, label } = channel;

  // ── Fader drag ─────────────────────────────────────────────

  const dragging  = useRef(false);
  const startY    = useRef(0);
  const startGain = useRef(gain);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current  = true;
    startY.current    = e.clientY;
    startGain.current = gain;
  }, [gain]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const deltaY  = startY.current - e.clientY;
    const range   = FADER_MAX_DB - FADER_MIN_DB;
    const deltaDb = (deltaY / FADER_HEIGHT) * range;
    const newGain = Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, startGain.current + deltaDb));
    onGainChange(index, Math.round(newGain * 10) / 10);
  }, [index, onGainChange]);

  const handlePointerUp = useCallback(() => { dragging.current = false; }, []);

  // Double-tap fader → reset 0 dB
  const lastFaderTap = useRef(0);
  const handleFaderTap = useCallback(() => {
    const now = Date.now();
    if (now - lastFaderTap.current < 300) onGainChange(index, 0);
    lastFaderTap.current = now;
  }, [index, onGainChange]);

  const thumbTop = (1 - dbToFaderPos(gain)) * 100;

  // ── Pan / Balance drag (horizontal) ────────────────────────

  const panDragging  = useRef(false);
  const panStartX    = useRef(0);
  const panStartVal  = useRef(balance);

  const handlePanDown = useCallback((e: React.PointerEvent) => {
    if (!onBalanceChange) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panDragging.current = true;
    panStartX.current   = e.clientX;
    panStartVal.current = balance;
  }, [balance, onBalanceChange]);

  const handlePanMove = useCallback((e: React.PointerEvent) => {
    if (!panDragging.current || !onBalanceChange) return;
    const deltaX   = e.clientX - panStartX.current;
    const newBal   = Math.min(1, Math.max(-1, panStartVal.current + deltaX / (PAN_WIDTH / 2)));
    onBalanceChange(index, Math.round(newBal * 100) / 100);
  }, [index, onBalanceChange]);

  const handlePanUp = useCallback(() => { panDragging.current = false; }, []);

  // Double-tap pan → reset to center
  const lastPanTap = useRef(0);
  const handlePanTap = useCallback(() => {
    if (!onBalanceChange) return;
    const now = Date.now();
    if (now - lastPanTap.current < 300) onBalanceChange(index, 0);
    lastPanTap.current = now;
  }, [index, onBalanceChange]);

  // Pan thumb position (0% = full L, 50% = center, 100% = full R)
  const panThumbLeft = ((balance + 1) / 2) * 100;
  const panLabel = balance === 0 ? 'C'
    : balance > 0 ? `R${Math.round(balance * 100)}`
    : `L${Math.round(-balance * 100)}`;

  // ── MixOption buttons ──────────────────────────────────────

  const isOn  = mixOption === MixOption.On;
  const isAFV = mixOption === MixOption.AFV;
  const isOff = mixOption === MixOption.Off;

  const toggleOn  = () => onMixOptionChange(index, isOn  ? MixOption.Off : MixOption.On);
  const toggleAFV = () => onMixOptionChange(index, isAFV ? MixOption.Off : MixOption.AFV);
  const toggleOff = () => { if (!isOff) onMixOptionChange(index, MixOption.Off); };

  // ── dB scale marks ─────────────────────────────────────────

  const scaleMarks = [-60, -40, -20, -10, -5, 0, 6];

  return (
    <div className="flex flex-col items-center gap-1 select-none" style={{ width: 72 }}>

      {/* Channel Label */}
      <div className="w-full text-center">
        <span
          className={`text-[10px] font-semibold tracking-wide uppercase truncate block px-1 py-0.5 rounded
            ${isMaster
              ? 'text-amber-300 bg-amber-950/50 border border-amber-800/60'
              : 'text-navy-300 bg-navy-800/60'
            }`}
          title={label}
        >
          {isMaster ? 'MSTR' : label}
        </span>
      </div>

      {/* VU + Fader side by side */}
      <div className="flex flex-row items-stretch gap-1">

        {/* VU Meter */}
        <VUMeter levels={levels} height={FADER_HEIGHT} compact={true} />

        {/* Fader section */}
        <div
          className="relative bg-navy-950 rounded border border-navy-700/60"
          style={{ width: 28, height: FADER_HEIGHT, touchAction: 'none' }}
        >
        {/* dB scale marks */}
        {scaleMarks.map((db) => {
          const pct = (1 - dbToFaderPos(db)) * 100;
          return (
            <div
              key={db}
              className="absolute right-0 flex items-center"
              style={{ top: `${pct}%`, transform: 'translateY(-50%)' }}
            >
              <div className="w-1.5 h-px bg-navy-600" />
            </div>
          );
        })}

        {/* Unity mark (0dB) */}
        <div
          className="absolute left-0 right-0 border-t border-dashed border-navy-500/70"
          style={{ top: `${(1 - dbToFaderPos(0)) * 100}%` }}
        />

        {/* Fader thumb */}
        <div
          className={`absolute left-1/2 -translate-x-1/2 cursor-grab active:cursor-grabbing
            rounded-sm shadow-lg z-10
            ${isMaster ? 'bg-amber-500 border-amber-400' : 'bg-blue-500 border-blue-400'}
            border`}
          style={{
            top: `${thumbTop}%`,
            transform: 'translateX(-50%) translateY(-50%)',
            width: 28,
            height: 12,
            touchAction: 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={handleFaderTap}
          title={`${formatDb(gain)} dB — double-tap to reset`}
        >
          <div className="absolute inset-x-1 top-1/2 -translate-y-1/2 flex flex-col gap-[2px]">
            {[0,1,2].map(i => (
              <div key={i} className="h-px bg-white/30 rounded" />
            ))}
          </div>
        </div>

        </div>{/* end fader */}
      </div>{/* end VU+fader row */}

      {/* dB Readout */}
      <div
        className={`text-[10px] font-mono font-semibold text-center py-0.5 px-1
          rounded bg-navy-950 border border-navy-700/50
          ${gain > 0 ? 'text-amber-400' : gain > -6 ? 'text-green-400' : 'text-navy-400'}`}
        style={{ minWidth: 40 }}
      >
        {formatDb(gain)}
      </div>

      {/* Pan / Balance slider */}
      <div className="flex flex-col items-center gap-0.5 w-full">
        {/* L / value / R labels */}
        <div className="flex justify-between w-full px-0.5">
          <span className="text-[8px] text-navy-600">L</span>
          <span className={`text-[8px] font-mono ${balance === 0 ? 'text-navy-500' : 'text-blue-400'}`}>
            {panLabel}
          </span>
          <span className="text-[8px] text-navy-600">R</span>
        </div>

        {/* Drag track */}
        <div
          className="relative bg-navy-950 rounded-sm border border-navy-700/50"
          style={{ width: '100%', height: 14, cursor: onBalanceChange ? 'ew-resize' : 'default', touchAction: 'none' }}
          onPointerDown={handlePanDown}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanUp}
          onPointerCancel={handlePanUp}
          onClick={handlePanTap}
          title="Pan — double-tap to center"
        >
          {/* Center line */}
          <div className="absolute top-0 bottom-0 w-px bg-navy-700" style={{ left: '50%' }} />

          {/* Fill bar from center */}
          {balance !== 0 && (
            <div
              className={`absolute top-1 bottom-1 ${isMaster ? 'bg-amber-500/40' : 'bg-blue-500/40'}`}
              style={balance > 0
                ? { left: '50%', width: `${(balance * 50)}%` }
                : { right: '50%', width: `${(-balance * 50)}%` }
              }
            />
          )}

          {/* Thumb */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full
              ${isMaster ? 'bg-amber-400' : 'bg-blue-400'}`}
            style={{ left: `${panThumbLeft}%`, width: 8, height: 8, pointerEvents: 'none' }}
          />
        </div>
      </div>

      {/* ON / AFV / OFF buttons */}
      {!isMaster && (
        <div className="flex flex-col gap-1 w-full">
          <button
            onClick={toggleOn}
            className={`w-full text-[10px] font-bold py-1 rounded transition-colors
              ${isOn
                ? 'bg-green-600 text-white shadow-[0_0_6px_#16a34a]'
                : 'bg-navy-800 text-navy-500 hover:bg-navy-700'}`}
          >
            ON
          </button>
          <button
            onClick={toggleAFV}
            className={`w-full text-[10px] font-bold py-1 rounded transition-colors
              ${isAFV
                ? 'bg-amber-500 text-white shadow-[0_0_6px_#d97706]'
                : 'bg-navy-800 text-navy-500 hover:bg-navy-700'}`}
          >
            AFV
          </button>
          <button
            onClick={toggleOff}
            className={`w-full text-[10px] font-bold py-1 rounded transition-colors
              ${isOff
                ? 'bg-red-700 text-white shadow-[0_0_6px_#b91c1c]'
                : 'bg-navy-800 text-navy-500 hover:bg-navy-700'}`}
          >
            OFF
          </button>
        </div>
      )}

      {isMaster && (
        <div className="text-[9px] text-amber-600 text-center uppercase tracking-wider">Master</div>
      )}
    </div>
  );
}
