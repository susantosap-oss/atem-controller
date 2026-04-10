import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.atempwa.app',
  appName: 'atemcontroller',
  webDir: 'out',
  server: {
    androidScheme: 'http',  // Harus http agar bisa connect ke localhost:4000 (embedded Node.js)
  },
};

export default config;
