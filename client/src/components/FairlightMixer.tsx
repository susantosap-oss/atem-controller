/**
 * FairlightMixer — main audio mixer layout.
 * Renders channel strips horizontally scrollable + Master on far right.
 * Matches Blackmagic Fairlight Audio Mixer aesthetic with navy theme.
 */
'use client';

import React, { useMemo } from 'react';
import AudioChannel from './AudioChannel';
import { AudioState, VUState } from '@/hooks/useATEM';
import { MixOptionValue } from '@/lib/constants';

interface FairlightMixerProps {
  audioState: AudioState | null;
  vuState: VUState;
  isConnected: boolean;
  onGainChange: (index: string | number, gain: number) => void;
  onMixOptionChange: (index: string | number, mixOption: MixOptionValue) => void;
  onBalanceChange: (index: string | number, balance: number) => void;
  onMasterGainChange: (gain: number) => void;
  onMasterBalanceChange: (balance: number) => void;
}

const CHANNEL_ORDER_HINTS = [1,2,3,4,5,6,7,8,1301,1302,2001,2002];

// ── Placeholder shown while disconnected ───────────────────────
const PLACEHOLDER_STATE: AudioState = {
  channels: {
    '1':    { gain: 0, balance: 0, mixOption: 0, label: 'HDMI 1' },
    '2':    { gain: 0, balance: 0, mixOption: 0, label: 'HDMI 2' },
    '3':    { gain: 0, balance: 0, mixOption: 0, label: 'HDMI 3' },
    '4':    { gain: 0, balance: 0, mixOption: 0, label: 'HDMI 4' },
    '1301': { gain: 0, balance: 0, mixOption: 0, label: 'MIC 1'  },
    '1302': { gain: 0, balance: 0, mixOption: 0, label: 'MIC 2'  },
  },
  master: { gain: 0, balance: 0, followFadeToBlack: false },
};

function sortChannels(channels: Record<string, unknown>): string[] {
  return Object.keys(channels).sort((a, b) => {
    const ai = CHANNEL_ORDER_HINTS.indexOf(Number(a));
    const bi = CHANNEL_ORDER_HINTS.indexOf(Number(b));
    if (ai === -1 && bi === -1) return Number(a) - Number(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}


export default function FairlightMixer({
  audioState,
  vuState,
  isConnected,
  onGainChange,
  onMixOptionChange,
  onBalanceChange,
  onMasterGainChange,
  onMasterBalanceChange,
}: FairlightMixerProps) {

  // Use real data when connected, placeholder when not
  const displayState = audioState ?? PLACEHOLDER_STATE;

  const sortedChannelKeys = useMemo(
    () => sortChannels(displayState.channels),
    [displayState]
  );

  return (
    <div className="flex flex-col h-full bg-navy-950">

      {/* ── Mixer Header Bar ──────────────────────────── */}
      <div className="flex items-center px-4 py-2 bg-navy-900
                      border-b border-navy-700/70 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {[0,1,2].map(i => (
              <div key={i} className="w-1 h-5 rounded-sm bg-blue-600 opacity-80" />
            ))}
          </div>
          <span className="text-sm font-bold tracking-wide text-navy-100">
            FAIRLIGHT AUDIO MIXER
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-navy-500">
            {sortedChannelKeys.length} CH + MASTER
          </span>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-600/30 border border-red-700/50" />
            <span className="text-[10px] text-navy-500">CLIP</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500/30 border border-amber-600/50" />
            <span className="text-[10px] text-navy-500">WARN</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/30 border border-green-600/50" />
            <span className="text-[10px] text-navy-500">OK</span>
          </div>
        </div>
      </div>

      {/* ── Main mixer area — always shown, greyed when disconnected ── */}
      <div className={`flex flex-1 overflow-hidden relative ${!isConnected ? 'pointer-events-none' : ''}`}>

        {/* Grey overlay when disconnected */}
        {!isConnected && (
          <div className="absolute inset-0 z-10 bg-navy-950/60 backdrop-blur-[1px]
                          flex items-center justify-center pointer-events-none">
            <span className="text-[10px] text-navy-500 uppercase tracking-widest font-semibold">
              Tidak terhubung ke ATEM
            </span>
          </div>
        )}

        {/* Channel strips — horizontally scrollable */}
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex items-stretch h-full gap-px min-w-max">

            {/* Section label */}
            <div className="flex flex-col justify-between px-2 py-3 shrink-0">
              <span className="text-[10px] text-navy-600 uppercase tracking-widest"
                    style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                Inputs
              </span>
            </div>

            {/* Channel strips */}
            {sortedChannelKeys.map((key) => {
              const ch = displayState.channels[key];
              if (!ch) return null;
              return (
                <div
                  key={key}
                  className="flex flex-col border-r border-navy-800/80
                             bg-navy-900/40 transition-colors"
                  style={{ padding: '8px 6px' }}
                >
                  <AudioChannel
                    index={key}
                    channel={ch}
                    levels={isConnected ? vuState[key] : undefined}
                    onGainChange={onGainChange}
                    onMixOptionChange={onMixOptionChange}
                    onBalanceChange={onBalanceChange}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Master strip — fixed right */}
        <div className="border-l-2 border-amber-800/60 bg-amber-950/10
                        shrink-0 flex flex-col justify-end"
             style={{ padding: '8px 8px' }}>
          <AudioChannel
            index="master"
            channel={{
              gain: displayState.master.gain,
              balance: displayState.master.balance,
              mixOption: 1,
              label: 'MASTER',
            }}
            levels={isConnected ? vuState['master'] : undefined}
            isMaster
            onGainChange={(_, g) => onMasterGainChange(g)}
            onMixOptionChange={() => {}}
            onBalanceChange={(_, b) => onMasterBalanceChange(b)}
          />
        </div>
      </div>

      {/* ── Bottom status bar ─────────────────────────── */}
      <div className="flex items-center px-4 py-1.5 bg-navy-950
                      border-t border-navy-800/60 shrink-0 gap-4">
        <span className="text-[10px] text-navy-600">
          BLACKMAGIC DESIGN — ATEM REMOTE
        </span>
        <div className="ml-auto flex gap-4 text-[10px] text-navy-600">
          <span>Fader: drag up/down · double-tap = 0dB</span>
          <span>ON = output on · AFV = audio follows video</span>
        </div>
      </div>
    </div>
  );
}
