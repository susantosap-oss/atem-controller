/**
 * Main page — tab navigation: AUDIO (Fairlight Mixer) | MEDIA (Media Pool).
 * Floating ConnectionPanel top-right, tab bar bottom.
 */
'use client';

import React, { useEffect, useState } from 'react';
import FairlightMixer  from '@/components/FairlightMixer';
import M32Mixer        from '@/components/M32Mixer';
import MediaPlayer     from '@/components/MediaPlayer';
import VideoSwitcher   from '@/components/VideoSwitcher';
import ConnectionPanel from '@/components/ConnectionPanel';
import { useSocket } from '@/hooks/useSocket';
import { useATEM }   from '@/hooks/useATEM';
import { useM32 }    from '@/hooks/useM32';

type ActiveTab    = 'video' | 'audio' | 'media';
type AudioSubTab  = 'fairlight' | 'm32';

export default function HomePage() {
  const { socket, socketStatus, serverUrl, connect: connectServer } = useSocket();

  const {
    atemStatus,
    audioState,
    vuState,
    mediaState,
    videoState,
    atemIP,
    connectATEM,
    disconnectATEM,
    setChannelGain,
    setChannelMixOption,
    setChannelBalance,
    setMasterGain,
    setMasterBalance,
    setMediaPlayerStill,
    setPreviewInput,
    setProgramInput,
    performAuto,
    performCut,
    setTransitionStyle,
    setTransitionPosition,
    performFTB,
    setDSKOnAir,
    autoDSKTransition,
  } = useATEM(socket);

  const {
    m32Status,
    channelNames,
    busNames,
    busConfig,
    sendLevels,
    busLevels,
    inputVu,
    busVu,
    connectM32,
    disconnectM32,
    setChannelSendLevel,
    setChannelSendOn,
    setBusLevel,
    setBusOn,
    queryBus,
  } = useM32(socket);

  const [activeTab,   setActiveTab]   = useState<ActiveTab>('video');
  const [audioSubTab, setAudioSubTab] = useState<AudioSubTab>('fairlight');

  // Prevent body scroll on mobile PWA
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Lock orientation to landscape on supported browsers / PWA
  useEffect(() => {
    const orient = screen?.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (orient?.lock) {
      orient.lock('landscape').catch(() => { /* silently ignore — desktop / unsupported */ });
    }
  }, []);

  const isConnected = atemStatus.status === 'connected';

  return (
    <main className="fixed inset-0 flex flex-col bg-navy-950 safe-top">

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
      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'video' && (
          <VideoSwitcher
            videoState={videoState}
            isConnected={isConnected}
            onSetPreviewInput={setPreviewInput}
            onSetProgramInput={setProgramInput}
            onPerformAuto={performAuto}
            onPerformCut={performCut}
            onSetTransitionStyle={setTransitionStyle}
            onSetTransitionPosition={setTransitionPosition}
            onPerformFTB={performFTB}
            onSetDSKOnAir={setDSKOnAir}
            onAutoDSKTransition={autoDSKTransition}
          />
        )}
        {activeTab === 'audio' && (
          <div className="flex flex-col h-full">
            {/* Audio sub-tab bar */}
            <div className="flex shrink-0 bg-navy-900 border-b border-navy-700/60">
              <AudioSubTabButton
                label="FAIRLIGHT"
                active={audioSubTab === 'fairlight'}
                onClick={() => setAudioSubTab('fairlight')}
              />
              <AudioSubTabButton
                label="MIDAS M32R LIVE"
                active={audioSubTab === 'm32'}
                onClick={() => setAudioSubTab('m32')}
                accent="purple"
              />
            </div>

            {/* Sub-tab content */}
            <div className="flex-1 overflow-hidden">
              {audioSubTab === 'fairlight' && (
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
              {audioSubTab === 'm32' && (
                <M32Mixer
                  m32Status={m32Status}
                  channelNames={channelNames}
                  busNames={busNames}
                  busConfig={busConfig}
                  sendLevels={sendLevels}
                  busLevels={busLevels}
                  inputVu={inputVu}
                  busVu={busVu}
                  serverConnected={socketStatus === 'connected'}
                  onConnect={connectM32}
                  onDisconnect={disconnectM32}
                  onChannelSendLevel={setChannelSendLevel}
                  onChannelSendOn={setChannelSendOn}
                  onBusLevel={setBusLevel}
                  onBusOn={setBusOn}
                  onQueryBus={queryBus}
                />
              )}
            </div>
          </div>
        )}
        {activeTab === 'media' && (
          <MediaPlayer
            mediaState={mediaState}
            videoState={videoState}
            isConnected={isConnected}
            onSetMediaPlayerStill={setMediaPlayerStill}
            onSetDSKOnAir={setDSKOnAir}
          />
        )}
      </div>

      {/* Tab bar */}
      <div className="flex shrink-0 border-t border-navy-700/60 bg-navy-950 safe-bottom">
        <TabButton
          label="VIDEO"
          icon={<VideoIcon />}
          active={activeTab === 'video'}
          onClick={() => setActiveTab('video')}
        />
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

// ── Audio sub-tab button ────────────────────────────────────

function AudioSubTabButton({
  label, active, onClick, accent = 'blue',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  accent?: 'blue' | 'purple';
}) {
  const activeColor = accent === 'purple'
    ? 'text-purple-400 border-b-2 border-purple-500 bg-navy-800/60'
    : 'text-blue-400 border-b-2 border-blue-500 bg-navy-800/60';
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-1.5 text-[10px] font-bold tracking-widest uppercase
        transition-colors border-b-2
        ${active ? activeColor : 'text-navy-500 border-transparent hover:text-navy-300'}`}
    >
      {label}
    </button>
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

function VideoIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="3" width="10" height="10" rx="1" strokeLinecap="round" />
      <path d="M11 6l4-2v8l-4-2V6z" strokeLinejoin="round" />
    </svg>
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
