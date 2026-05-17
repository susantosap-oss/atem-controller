/**
 * Main page — tab navigation: VIDEO | AUDIO (locked) | MEDIA
 * Tab AUDIO terkunci; tap → login modal. Setelah login berhasil,
 * tab Audio tampil penuh dan status unlock disimpan di localStorage.
 */
'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import FairlightMixer  from '@/components/FairlightMixer';
import M32Mixer        from '@/components/M32Mixer';
import MediaPlayer     from '@/components/MediaPlayer';
import VideoSwitcher   from '@/components/VideoSwitcher';
import ConnectionPanel from '@/components/ConnectionPanel';
import { useSocket } from '@/hooks/useSocket';
import { useATEM }   from '@/hooks/useATEM';
import { useM32 }    from '@/hooks/useM32';

// Ganti password sesuai kebutuhan
const AUDIO_PASSWORD = '1234';
const STORAGE_KEY    = 'audio_tab_unlocked';

type ActiveTab   = 'video' | 'audio' | 'media';
type AudioSubTab = 'fairlight' | 'm32';

export default function HomePage() {
  const { socket, socketStatus, serverUrl, connect: connectServer } = useSocket();

  const {
    atemStatus, audioState, vuState, mediaState, videoState, atemIP,
    connectATEM, disconnectATEM,
    setChannelGain, setChannelMixOption, setChannelBalance,
    setMasterGain, setMasterBalance,
    setMediaPlayerStill, setPreviewInput, setProgramInput,
    performAuto, performCut, setTransitionStyle, setTransitionPosition,
    performFTB, setDSKOnAir, autoDSKTransition,
  } = useATEM(socket);

  const {
    m32Status, channelNames, busNames, busConfig,
    sendLevels, sendPre, busLevels, inputVu, busVu,
    connectM32, disconnectM32,
    setChannelSendLevel, setChannelSendOn, setBusLevel, setBusOn, queryBus,
  } = useM32(socket);

  const [activeTab,      setActiveTab]      = useState<ActiveTab>('video');
  const [audioSubTab,    setAudioSubTab]    = useState<AudioSubTab>('fairlight');
  const [audioUnlocked,  setAudioUnlocked]  = useState(false);
  const [showLogin,      setShowLogin]      = useState(false);
  const [loginInput,     setLoginInput]     = useState('');
  const [loginError,     setLoginError]     = useState(false);
  const [loginShake,     setLoginShake]     = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Baca status unlock dari localStorage saat mount
  useEffect(() => {
    try {
      setAudioUnlocked(localStorage.getItem(STORAGE_KEY) === '1');
    } catch { /* storage unavailable */ }
  }, []);

  // Prevent body scroll on mobile PWA
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Lock orientation landscape
  useEffect(() => {
    const orient = screen?.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (orient?.lock) orient.lock('landscape').catch(() => {});
  }, []);

  // Fokus input saat modal terbuka
  useEffect(() => {
    if (showLogin) {
      setLoginInput('');
      setLoginError(false);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [showLogin]);

  const handleAudioTabPress = () => {
    if (audioUnlocked) {
      setActiveTab('audio');
    } else {
      setShowLogin(true);
    }
  };

  const handleLogin = () => {
    if (loginInput === AUDIO_PASSWORD) {
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
      setAudioUnlocked(true);
      setShowLogin(false);
      setActiveTab('audio');
    } else {
      setLoginError(true);
      setLoginShake(true);
      setTimeout(() => setLoginShake(false), 400);
      setLoginInput('');
    }
  };

  const handleLockAudio = () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setAudioUnlocked(false);
    if (activeTab === 'audio') setActiveTab('video');
  };

  const isConnected = atemStatus.status === 'connected';

  return (
    <main className="fixed inset-0 flex flex-col bg-navy-950 safe-top">

      {/* ── Login modal ─────────────────────────────────────── */}
      {showLogin && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className={`bg-navy-900 border border-navy-700 rounded-2xl px-8 py-6 w-72 flex flex-col gap-4
            shadow-2xl ${loginShake ? 'animate-shake' : ''}`}
          >
            {/* Header */}
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="7" width="10" height="8" rx="1.5" />
                <path d="M5 7V5a3 3 0 0 1 6 0v2" strokeLinecap="round" />
              </svg>
              <span className="text-[11px] font-bold tracking-widest uppercase text-navy-200">
                Audio Access
              </span>
            </div>

            {/* Input */}
            <input
              ref={inputRef}
              type="password"
              value={loginInput}
              onChange={e => { setLoginInput(e.target.value); setLoginError(false); }}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="Password"
              className={`bg-navy-800 border rounded-xl px-4 py-2.5 text-sm text-white
                placeholder-navy-600 outline-none transition-colors
                ${loginError
                  ? 'border-red-500 focus:border-red-400'
                  : 'border-navy-700 focus:border-blue-500'
                }`}
            />

            {loginError && (
              <p className="text-[10px] text-red-400 -mt-2 tracking-wide">Password salah</p>
            )}

            {/* Buttons */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowLogin(false)}
                className="flex-1 py-2 rounded-xl text-[11px] font-bold tracking-widest uppercase
                  bg-navy-800 border border-navy-700 text-navy-400
                  hover:text-navy-200 hover:border-navy-600 transition-colors"
              >
                Batal
              </button>
              <button
                onClick={handleLogin}
                className="flex-1 py-2 rounded-xl text-[11px] font-bold tracking-widest uppercase
                  bg-blue-600 border border-blue-500 text-white
                  hover:bg-blue-500 active:scale-95 transition-all"
              >
                Masuk
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Tab content */}
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
        {activeTab === 'audio' && audioUnlocked && (
          <div className="flex flex-col h-full">
            {/* Audio sub-tab bar + lock button */}
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
                accent="navy"
              />
              {/* Lock button — kunci kembali tab Audio */}
              <button
                onClick={handleLockAudio}
                title="Kunci tab Audio"
                className="px-3 text-navy-600 hover:text-amber-400 transition-colors shrink-0"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="7" width="10" height="8" rx="1.5" />
                  <path d="M5 7V5a3 3 0 0 1 6 0v2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
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
                  sendPre={sendPre}
                  busLevels={busLevels}
                  inputVu={inputVu}
                  busVu={busVu}
                  serverConnected={Capacitor.isNativePlatform() || socketStatus === 'connected'}
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
          label="MEDIA"
          icon={<MediaIcon />}
          active={activeTab === 'media'}
          onClick={() => setActiveTab('media')}
          badge={mediaState ? Object.values(mediaState.stillPool).filter(s => s.isUsed).length : undefined}
        />
        <TabButton
          label="AUDIO"
          icon={<AudioIcon locked={!audioUnlocked} />}
          active={activeTab === 'audio'}
          onClick={handleAudioTabPress}
          locked={!audioUnlocked}
        />
      </div>

      <style jsx global>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%      { transform: translateX(-6px); }
          40%      { transform: translateX(6px); }
          60%      { transform: translateX(-4px); }
          80%      { transform: translateX(4px); }
        }
        .animate-shake { animation: shake 0.4s ease; }
      `}</style>
    </main>
  );
}

// ── Audio sub-tab button ──────────────────────────────────────

function AudioSubTabButton({
  label, active, onClick, accent = 'blue',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  accent?: 'blue' | 'navy';
}) {
  const activeColor = accent === 'navy'
    ? 'text-navy-400 border-b-2 border-navy-500 bg-navy-800/60'
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

// ── Tab button ────────────────────────────────────────────────

function TabButton({
  label, icon, active, onClick, badge, locked,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
  locked?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold
        tracking-widest uppercase transition-colors relative
        ${active
          ? 'text-blue-400 border-t-2 border-blue-500 bg-navy-900/60'
          : locked
            ? 'text-navy-600 border-t-2 border-transparent'
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

// ── Icons ─────────────────────────────────────────────────────

function VideoIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="3" width="10" height="10" rx="1" strokeLinecap="round" />
      <path d="M11 6l4-2v8l-4-2V6z" strokeLinejoin="round" />
    </svg>
  );
}

function AudioIcon({ locked }: { locked?: boolean }) {
  if (locked) {
    return (
      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="7" width="10" height="8" rx="1.5" />
        <path d="M5 7V5a3 3 0 0 1 6 0v2" strokeLinecap="round" />
      </svg>
    );
  }
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
