# ATEM Controller 2026 — Build & Setup Guide

## Project Structure

```
atem-controller2026/
├── server/                  # Electron app (Windows .exe)
│   ├── src/
│   │   ├── main.js          # Electron main process
│   │   ├── preload.js       # Secure IPC bridge
│   │   ├── tray.js          # System tray
│   │   ├── atem-manager.js  # atem-connection wrapper
│   │   ├── socket-bridge.js # Socket.io server + VU throttle
│   │   ├── config.js        # electron-settings persistence
│   │   └── renderer/
│   │       └── index.html   # Server dashboard UI
│   ├── assets/
│   │   ├── icon.ico         # ← ADD YOUR ICON HERE
│   │   └── icon.png
│   └── package.json
│
└── client/                  # Next.js PWA
    ├── src/
    │   ├── app/
    │   │   ├── layout.tsx   # PWA meta, theme
    │   │   ├── page.tsx     # Main page
    │   │   └── globals.css
    │   ├── components/
    │   │   ├── FairlightMixer.tsx   # Main mixer layout
    │   │   ├── AudioChannel.tsx     # Channel strip + fader
    │   │   ├── VUMeter.tsx          # Stereo level meter
    │   │   └── ConnectionPanel.tsx  # IP inputs + status
    │   ├── hooks/
    │   │   ├── useSocket.ts  # Socket.io lifecycle
    │   │   └── useATEM.ts    # ATEM state + commands
    │   └── lib/
    │       ├── socket.ts     # Singleton socket + localStorage
    │       └── constants.ts  # dB math, MixOption enum
    └── public/
        └── manifest.json    # PWA manifest
```

---

## 1. Server Setup (Electron)

```bash
cd server
npm install
```

### Development
```bash
npm run dev
```

### Build .exe (requires Windows or Wine)
```bash
npm run build
# Output: server/dist/ATEM Controller Setup 1.0.0.exe
```

The NSIS installer will:
- Install the app to Program Files
- Create Desktop + Start Menu shortcuts
- Register auto-uninstall

### Adding your icon
Place `icon.ico` (256x256) and `icon.png` (512x512) in `server/assets/`.
Generate from PNG: https://icoconvert.com

---

## 2. Client Setup (Next.js PWA)

```bash
cd client
npm install
npm run dev       # Dev server on http://localhost:3000
npm run build     # Production build
npm run start     # Production server
```

### Deploy to local network
Option A — Next.js standalone:
```bash
npm run build && npm run start -- -H 0.0.0.0 -p 3000
```

Option B — Static export (no server needed):
Add `output: 'export'` to `next.config.js`, then serve the `out/` folder with any static server (nginx, serve, etc.).

---

## 3. Network Configuration

```
[ATEM Mini Pro]                [Windows PC]                 [HP/Tablet]
192.168.1.150    ──Ethernet──  192.168.1.100                via WiFi
  UDP:9910    ──────────────►  Electron Server       http://192.168.1.100:3000
                               Socket.io :4000  ◄──────── PWA di browser
                               Next.js   :3000
```

### Topologi Jaringan
```
Router (192.168.1.1)
  ├── PC (Ethernet) → 192.168.1.100  [Electron Server + Next.js]
  ├── ATEM Mini Pro (Ethernet) → 192.168.1.150  [UDP:9910]
  └── HP/Tablet (WiFi) → 192.168.1.xxx  [Browser → PWA]
```

### Yang harus dibuka di Windows Firewall
| Port | Protocol | Fungsi |
|------|----------|--------|
| 4000 | TCP | Socket.io WebSocket bridge |
| 3000 | TCP | Next.js PWA (jika serve dari PC yang sama) |

### Cara buka Firewall (Windows)
```
Windows Defender Firewall → Advanced Settings
→ Inbound Rules → New Rule → Port → TCP → 3000, 4000 → Allow
```

### IP Statis ATEM
ATEM sudah dikonfigurasi dengan IP statis **192.168.1.150** (via Ethernet).

---

## 4. Socket.io Events Reference

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `server:handshake` | `{ atemIP, serverPort, atemStatus }` | Sent on connect |
| `atem:status` | `{ status, message, ip }` | ATEM connection changes |
| `atem:audioState` | `{ channels, master }` | Full audio state |
| `atem:vuMeter` | `{ [chIdx]: { left, right, peakLeft, peakRight } }` | Throttled VU (30fps) |

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `atem:connect` | `{ ip }` | Connect ATEM at IP |
| `atem:disconnect` | — | Disconnect ATEM |
| `atem:setGain` | `{ index, gain }` | Set channel fader (dB) |
| `atem:setMixOption` | `{ index, mixOption }` | 0=Off, 1=On, 4=AFV |
| `atem:setBalance` | `{ index, balance }` | -1.0 to +1.0 |
| `atem:setMasterGain` | `{ gain }` | Master fader |

---

## 5. VU Meter Throttling

```
ATEM UDP events (raw, ~50fps)
         ↓
  atem-manager.js (emits 'vuMeter')
         ↓
  socket-bridge.js throttle engine:
  - Buffers in pendingVu
  - Flushes at max 30fps (33ms)
  - Delta filter: skip if Δ < 0.5 dB
         ↓
  Socket.io broadcast → client
         ↓
  useATEM.ts RAF loop:
  - Exponential smoothing (α = 0.25)
  - Runs at 60fps via requestAnimationFrame
  - Only triggers re-render when visible change
```

---

## 6. PWA Installation

### Android (Chrome)
1. Open `http://[SERVER_IP]:3000` in Chrome
2. Tap "Add to Home Screen" from the menu
3. App launches in fullscreen landscape mode

### iOS (Safari)
1. Open in Safari
2. Share → "Add to Home Screen"
3. App uses `apple-mobile-web-app-capable` for fullscreen

---

## 7. IP Persistence

| Location | What | Storage |
|----------|------|---------|
| Server | ATEM IP, port, runOnStartup | `electron-settings` (JSON, `%APPDATA%`) |
| PWA | Server URL | `localStorage['atem_server_url']` |
| PWA | ATEM IP | `localStorage['atem_ip']` |

On PWA load, both IPs are restored. On `server:handshake`, the server's saved ATEM IP overwrites the PWA's local copy to keep them in sync.
