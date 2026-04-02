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

function EmptyState({ isConnected }: { isConnected: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
      <div className="w-16 h-16 rounded-full bg-navy-800 border border-navy-700 flex items-center justify-center">
        <svg className="w-8 h-8 text-navy-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M9 9l3-3m0 0l3 3m-3-3v8m-4.5 4.5h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 003 10.5v9a2.25 2.25 0 002.25 2.25z"/>
        </svg>
      </div>
      <div>
        <p className="text-navy-300 font-semibold">
          {isConnected ? 'No Audio Channels' : 'ATEM Not Connected'}
        </p>
        <p className="text-navy-500 text-sm mt-1">
          {isConnected
            ? 'Waiting for audio state from ATEM...'
            : 'Enter the ATEM IP address in the connection panel to get started.'}
        </p>
      </div>
    </div>
  );
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

  const sortedChannelKeys = useMemo(
    () => audioState ? sortChannels(audioState.channels) : [],
    [audioState]
  );

  return (
    <div className="flex flex-col h-full bg-navy-950">

      {/* ── Mixer Header Bar ──────────────────────────── */}
      <div className="flex items-center px-4 py-2 bg-navy-900
                      border-b border-navy-700/70 shrink-0">
        <div className="flex items-center gap-2">
          {/* BMD-style logo accent */}
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
          {audioState && (
            <span className="text-[11px] text-navy-500">
              {sortedChannelKeys.length} CH + MASTER
            </span>
          )}
          {/* Clip indicator */}
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

      {/* ── Main mixer area ───────────────────────────── */}
      {!audioState ? (
        <EmptyState isConnected={isConnected} />
      ) : (
        <div className="flex flex-1 overflow-hidden">

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
                const ch = audioState.channels[key];
                if (!ch) return null;
                return (
                  <div
                    key={key}
                    className="flex flex-col border-r border-navy-800/80
                               bg-navy-900/40 hover:bg-navy-800/30 transition-colors"
                    style={{ padding: '8px 6px' }}
                  >
                    <AudioChannel
                      index={key}
                      channel={ch}
                      levels={vuState[key]}
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
                gain: audioState.master.gain,
                balance: audioState.master.balance,
                mixOption: 1, // always on
                label: 'MASTER',
              }}
              levels={vuState['master']}
              isMaster
              onGainChange={(_, g) => onMasterGainChange(g)}
              onMixOptionChange={() => {}}
              onBalanceChange={(_, b) => onMasterBalanceChange(b)}
            />
          </div>
        </div>
      )}

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
