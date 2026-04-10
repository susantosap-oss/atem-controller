/**
 * ConnectionPanel — dual IP inputs: Server URL (web only) + ATEM IP.
 * Di APK (Capacitor native): Server URL disembunyikan, embedded Node.js auto-connect localhost:4000.
 * Di Web PWA: Server URL + ATEM IP keduanya ditampilkan.
 */
'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { SocketStatus } from '@/hooks/useSocket';
import { ATEMStatus } from '@/hooks/useATEM';
import { getStoredServerUrl, setStoredServerUrl } from '@/lib/socket';

interface ConnectionPanelProps {
  socketStatus: SocketStatus;
  atemStatus: ATEMStatus;
  atemIP: string;
  serverUrl: string;
  onConnectServer: (url: string) => void;
  onConnectATEM: (ip: string) => void;
  onDisconnectATEM: () => void;
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const configs: Record<string, { dot: string; text: string; ring: string }> = {
    connected:    { dot: 'bg-green-500',  text: 'text-green-400',  ring: 'shadow-[0_0_6px_#22c55e]' },
    connecting:   { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', ring: '' },
    disconnected: { dot: 'bg-navy-600',   text: 'text-navy-400',   ring: '' },
    error:        { dot: 'bg-red-500',    text: 'text-red-400',    ring: '' },
  };
  const c = configs[status] || configs.disconnected;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${c.text}`}>
      <span className={`w-2 h-2 rounded-full ${c.dot} ${c.ring}`} />
      {label}
    </span>
  );
}

export default function ConnectionPanel({
  socketStatus,
  atemStatus,
  atemIP,
  serverUrl,
  onConnectServer,
  onConnectATEM,
  onDisconnectATEM,
}: ConnectionPanelProps) {
  const isNative = Capacitor.isNativePlatform();

  const [serverInput, setServerInput] = useState(serverUrl);
  const [atemInput,   setAtemInput]   = useState(atemIP);
  const [collapsed,   setCollapsed]   = useState(false);

  // Sync input field when server handshake delivers a saved ATEM IP
  useEffect(() => {
    if (atemIP) setAtemInput(atemIP);
  }, [atemIP]);

  const handleServerConnect = useCallback(() => {
    const url = serverInput.trim();
    if (!url) return;
    setStoredServerUrl(url);
    onConnectServer(url);
  }, [serverInput, onConnectServer]);

  const handleAtemConnect = useCallback(() => {
    const ip = atemInput.trim();
    if (!ip) return;
    onConnectATEM(ip);
  }, [atemInput, onConnectATEM]);

  if (collapsed) {
    return (
      <div className="fixed top-[max(env(safe-area-inset-top),0.5rem)] right-2 z-50 flex items-center gap-2
                      bg-navy-900/90 backdrop-blur border border-navy-700/60
                      rounded-full px-3 py-1.5 shadow-xl">
        {!isNative && (
          <>
            <StatusBadge status={socketStatus} label="WS" />
            <span className="text-navy-600 text-xs">|</span>
          </>
        )}
        <StatusBadge status={atemStatus.status} label="ATEM" />
        <button
          onClick={() => setCollapsed(false)}
          className="ml-1 text-navy-400 hover:text-navy-200 text-xs"
          title="Expand connection panel"
        >
          ⚙
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-[max(env(safe-area-inset-top),0.5rem)] right-2 z-50 w-72
                    bg-navy-900/95 backdrop-blur border border-navy-700/60
                    rounded-xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2
                      bg-navy-950/60 border-b border-navy-700/50">
        <span className="text-xs font-semibold text-navy-300 uppercase tracking-wider">
          {isNative ? 'ATEM Connection' : 'Connection'}
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-navy-500 hover:text-navy-300 text-xs leading-none"
          title="Collapse"
        >
          ✕
        </button>
      </div>

      <div className="p-3 flex flex-col gap-3">

        {/* ── Server URL — hanya tampil di Web PWA, bukan APK ── */}
        {!isNative && (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-navy-400 uppercase tracking-wide">
                  Server URL
                </span>
                <StatusBadge status={socketStatus} label={socketStatus} />
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={serverInput}
                  onChange={e => setServerInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleServerConnect()}
                  placeholder="http://192.168.1.100:4000"
                  className="flex-1 bg-navy-950 border border-navy-700/60 rounded-lg
                             text-navy-100 text-xs font-mono px-2.5 py-1.5
                             placeholder:text-navy-600 focus:outline-none
                             focus:border-blue-600 transition-colors"
                />
                <button
                  onClick={handleServerConnect}
                  disabled={socketStatus === 'connected' && serverInput === serverUrl}
                  className="px-2.5 py-1.5 text-xs font-semibold rounded-lg
                             bg-blue-700 hover:bg-blue-600 text-white
                             disabled:opacity-40 disabled:cursor-not-allowed
                             transition-colors"
                >
                  {socketStatus === 'connected' ? 'Re' : ''}Connect
                </button>
              </div>
              {socketStatus === 'error' && (
                <p className="text-[10px] text-red-400">
                  Cannot reach server. Check IP and port.
                </p>
              )}
            </div>

            <div className="border-t border-navy-700/40" />
          </>
        )}

        {/* ── Embedded server status — hanya APK ── */}
        {isNative && socketStatus !== 'connected' && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-navy-400 uppercase tracking-wide">
              Local Server
            </span>
            <StatusBadge status={socketStatus} label={socketStatus} />
          </div>
        )}

        {/* ── ATEM IP ──────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-navy-400 uppercase tracking-wide">
              ATEM IP Address
            </span>
            <StatusBadge status={atemStatus.status} label={atemStatus.status} />
          </div>

          {atemStatus.message && atemStatus.status === 'error' && (
            <p className="text-[10px] text-red-400 bg-red-950/30 rounded px-2 py-1">
              {atemStatus.message}
            </p>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={atemInput}
              onChange={e => setAtemInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAtemConnect()}
              placeholder="192.168.1.240"
              disabled={socketStatus !== 'connected'}
              className="flex-1 bg-navy-950 border border-navy-700/60 rounded-lg
                         text-navy-100 text-xs font-mono px-2.5 py-1.5
                         placeholder:text-navy-600 focus:outline-none
                         focus:border-blue-600 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            />
            {atemStatus.status !== 'connected' ? (
              <button
                onClick={handleAtemConnect}
                disabled={socketStatus !== 'connected'}
                className="px-2.5 py-1.5 text-xs font-semibold rounded-lg
                           bg-green-700 hover:bg-green-600 text-white
                           disabled:opacity-40 disabled:cursor-not-allowed
                           transition-colors"
              >
                Connect
              </button>
            ) : (
              <button
                onClick={onDisconnectATEM}
                className="px-2.5 py-1.5 text-xs font-semibold rounded-lg
                           bg-red-700 hover:bg-red-600 text-white
                           transition-colors"
              >
                Disco
              </button>
            )}
          </div>
          {atemStatus.status === 'connecting' && (
            <p className="text-[10px] text-amber-400 flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              Connecting to {atemInput}...
            </p>
          )}
        </div>

        {/* Handshake indicator */}
        <div className={`rounded-lg px-2.5 py-1.5 text-[10px] font-medium
          ${atemStatus.status === 'connected'
            ? 'bg-green-950/40 border border-green-800/40 text-green-400'
            : socketStatus === 'connected'
            ? 'bg-navy-800/40 border border-navy-700/40 text-navy-500'
            : 'bg-red-950/20 border border-red-900/30 text-red-500/70'
          }`}>
          {atemStatus.status === 'connected'
            ? `Handshake OK — ${atemStatus.ip || atemInput}`
            : socketStatus === 'connected'
            ? 'Server ready, ATEM not linked'
            : isNative
            ? 'Starting embedded server...'
            : 'Server unreachable'
          }
        </div>
      </div>
    </div>
  );
}
