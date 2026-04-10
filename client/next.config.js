/** @type {import('next').NextConfig} */
const withPWA = require('@ducanh2912/next-pwa').default({
  dest: 'public',
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development',
  workboxOptions: {
    disableDevLogs: true,
    runtimeCaching: [
      {
        // Cache PWA static assets — http:// for LAN access, https:// for hosted
        urlPattern: /^https?:\/\/.+\/_next\/static\/.+/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'next-static',
          expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 3600 },
        },
      },
      {
        // NetworkFirst for pages — exclude Socket.io polling to avoid caching WS fallback
        urlPattern: ({ url }) =>
          /^https?/.test(url.protocol) && !url.pathname.startsWith('/socket.io'),
        handler: 'NetworkFirst',
        options: {
          cacheName: 'atem-cache',
          networkTimeoutSeconds: 8,
          expiration: { maxEntries: 50, maxAgeSeconds: 24 * 3600 },
        },
      },
    ],
  },
});

const nextConfig = {
  reactStrictMode: true,
  // Standalone mode: self-contained server.js — required for Docker / Cloud Run
  output: 'export',
  // Penting: Next.js export tidak mendukung Image Optimization bawaan secara default di APK
  images: {
    unoptimized: true,
 },
};

module.exports = withPWA(nextConfig);
