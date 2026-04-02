/**
 * Main page — tab navigation: AUDIO (Fairlight Mixer) | MEDIA (Media Pool).
 * Floating ConnectionPanel top-right, tab bar bottom.
 */
'use client';

import React, { useEffect, useState } from 'react';
import FairlightMixer from '@/components/FairlightMixer';
import MediaPlayer    from '@/components/MediaPlayer';
import ConnectionPanel from '@/components/ConnectionPanel';
import { useSocket } from '@/hooks/useSocket';
import { useATEM }   from '@/hooks/useATEM';

type ActiveTab = 'audio' | 'media';

export default function HomePage() {
  const { socket, socketStatus, serverUrl, connect: connectServer } = useSocket();

  const {
    atemStatus,
    audioState,
    vuState,
    mediaState,
    atemIP,
    connectATEM,
    disconnectATEM,
    setChannelGain,
    setChannelMixOption,
    setChannelBalance,
    setMasterGain,
    setMasterBalance,
    setMediaPlayerStill,
  } = useATEM(socket);

  const [activeTab, setActiveTab] = useState<ActiveTab>('audio');

  // Prevent body scroll on mobile PWA
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const isConnected = atemStatus.status === 'connected';

  return (
    <main className="fixed inset-0 flex flex-col bg-navy-950">

      {/* Floating connection panel */}
      <ConnectionPanel
        socketStatus={socketStatus}
        atemStatus={atemStatus}
        atemIP={atemIP}
        serverUrl={serverUrl}
        onConnectServer={connectServer}
        onConnectATEM={connectATEM}
        onDisconnectATEM={disconnectATEM}
      />

      {/* Tab content — fills all space above tab bar */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'audio' && (
          <FairlightMixer
            audioState={audioState}
            vuState={vuState}
            isConnected={isConnected}
            onGainChange={setChannelGain}
            onMixOptionChange={setChannelMixOption}
            onBalanceChange={setChannelBalance}
            onMasterGainChange={setMasterGain}
            onMasterBalanceChange={setMasterBalance}
          />
        )}
        {activeTab === 'media' && (
          <MediaPlayer
            mediaState={mediaState}
            isConnected={isConnected}
            onSetMediaPlayerStill={setMediaPlayerStill}
          />
        )}
      </div>

      {/* Tab bar */}
      <div className="flex shrink-0 border-t border-navy-700/60 bg-navy-950">
        <TabButton
          label="AUDIO"
          icon={<AudioIcon />}
          active={activeTab === 'audio'}
          onClick={() => setActiveTab('audio')}
        />
        <TabButton
          label="MEDIA"
          icon={<MediaIcon />}
          active={activeTab === 'media'}
          onClick={() => setActiveTab('media')}
          badge={mediaState ? Object.values(mediaState.stillPool).filter(s => s.isUsed).length : undefined}
        />
      </div>
    </main>
  );
}

// ── Tab button ─────────────────────────────────────────────────

function TabButton({
  label,
  icon,
  active,
  onClick,
  badge,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold
        tracking-widest uppercase transition-colors relative
        ${active
          ? 'text-blue-400 border-t-2 border-blue-500 bg-navy-900/60'
          : 'text-navy-500 border-t-2 border-transparent hover:text-navy-300'
        }`}
    >
      {icon}
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-1 right-[calc(50%-24px)] bg-amber-600 text-white
                         text-[8px] font-bold rounded-full px-1 leading-tight min-w-[14px] text-center">
          {badge}
        </span>
      )}
    </button>
  );
}

function AudioIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="3"  y1="4"  x2="3"  y2="12" strokeLinecap="round" />
      <line x1="6"  y1="6"  x2="6"  y2="12" strokeLinecap="round" />
      <line x1="9"  y1="3"  x2="9"  y2="12" strokeLinecap="round" />
      <line x1="12" y1="5"  x2="12" y2="12" strokeLinecap="round" />
      <line x1="1"  y1="13" x2="15" y2="13" strokeLinecap="round" />
    </svg>
  );
}

function MediaIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="2" width="14" height="10" rx="1.5" strokeLinecap="round" />
      <path d="M6 5.5l4 2.5-4 2.5V5.5z" strokeLinejoin="round" />
      <line x1="4" y1="14" x2="12" y2="14" strokeLinecap="round" />
    </svg>
  );
}
