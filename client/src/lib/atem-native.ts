/**
 * atem-native.ts — TypeScript wrapper untuk AtemPlugin (native Android).
 * Di APK: panggil plugin Java langsung via Capacitor (UDP langsung ke ATEM).
 * Di Web: tidak dipakai (gunakan socket.io ke server PC).
 */
import { registerPlugin } from '@capacitor/core';

export interface AtemPlugin {
  connect(options: { ip: string }): Promise<void>;
  disconnect(): Promise<void>;
  setChannelGain(options: { index: number; gain: number }): Promise<void>;
  setChannelMixOption(options: { index: number; mixOption: number }): Promise<void>;
  setChannelBalance(options: { index: number; balance: number }): Promise<void>;
  setMasterGain(options: { gain: number }): Promise<void>;
  setMasterBalance(options: { balance: number }): Promise<void>;
  setPreviewInput(options: { source: number }): Promise<void>;
  setProgramInput(options: { source: number }): Promise<void>;
  performAuto(): Promise<void>;
  performCut(): Promise<void>;
  setTransitionStyle(options: { style: number }): Promise<void>;
  setTransitionPosition(options: { position: number }): Promise<void>;
  performFTB(): Promise<void>;
  setDSKOnAir(options: { keyerIndex: number; onAir: boolean }): Promise<void>;
  autoDSKTransition(options: { keyerIndex: number }): Promise<void>;
  setMediaPlayerStill(options: { playerIndex: number; stillIndex: number }): Promise<void>;
  addListener(event: string, cb: (data: any) => void): Promise<{ remove: () => void }>;
}

export const AtemNative = registerPlugin<AtemPlugin>('Atem');
