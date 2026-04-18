/**
 * m32-native.ts — TypeScript wrapper untuk M32Plugin (native Android).
 * Di APK: panggil plugin Java langsung via Capacitor (OSC UDP ke M32).
 * Di Web: tidak dipakai (gunakan socket.io ke server PC).
 */
import { registerPlugin } from '@capacitor/core';

export interface M32Plugin {
  connect(options: { ip: string }): Promise<void>;
  disconnect(): Promise<void>;
  setChannelSendLevel(options: { ch: string; bus: string; level: number }): Promise<void>;
  setChannelSendOn(options: { ch: string; bus: string; on: boolean }): Promise<void>;
  setBusLevel(options: { bus: string; level: number }): Promise<void>;
  setBusOn(options: { bus: string; on: boolean }): Promise<void>;
  queryBus(options: { bus: number }): Promise<void>;
  addListener(event: string, cb: (data: any) => void): Promise<{ remove: () => void }>;
}

export const M32Native = registerPlugin<M32Plugin>('M32');
