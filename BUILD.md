# ATEM Controller 2026 — Build & Setup Guide

## Project Structure

```
atem-controller2026/
├── server/                  # Electron app (Windows .exe)
│   ├── src/
│   │   ├── main.js          # Electron main process
│   │   ├── preload.js       # Secure IPC bridge
│   │   ├── tray.js          # System tray
│   │   ├── atem-manager.js  # atem-connection wrapper + video/audio/media commands
│   │   ├── socket-bridge.js # Socket.io server + VU throttle
│   │   ├── config.js        # electron-settings persistence
│   │   └── renderer/
│   │       └── index.html   # Server dashboard UI
│   ├── assets/
│   │   ├── icon.ico         # ← ADD YOUR ICON HERE
│   │   └── icon.png
│   ├── build.bat            # One-click build script for Windows
│   └── package.json
│
└── client/                  # Next.js PWA
    ├── src/
    │   ├── app/
    │   │   ├── layout.tsx   # PWA meta, theme
    │   │   ├── page.tsx     # Main page + 3-tab nav (VIDEO/AUDIO/MEDIA)
    │   │   └── globals.css
    │   ├── components/
    │   │   ├── VideoSwitcher.tsx    # PGM/PVW bus, AUTO/CUT/FTB, transition style
    │   │   ├── FairlightMixer.tsx   # Main mixer layout
    │   │   ├── AudioChannel.tsx     # Channel strip + fader
    │   │   ├── VUMeter.tsx          # Stereo level meter
    │   │   ├── MediaPlayer.tsx      # Media pool + still slots
    │   │   └── ConnectionPanel.tsx  # IP inputs + status
    │   ├── hooks/
    │   │   ├── useSocket.ts  # Socket.io lifecycle
    │   │   └── useATEM.ts    # ATEM state + commands (audio/video/media)
    │   └── lib/
    │       ├── socket.ts     # Singleton socket + localStorage
    │       └── constants.ts  # dB math, MixOption enum
    └── public/
        └── manifest.json    # PWA manifest
```

---

## 1. Windows Installation (End User)

> Langkah ini untuk **menjalankan ATEM Controller di PC Windows** sebagai server.

### Prasyarat
- Windows 10 / 11 (64-bit)
- [Node.js LTS](https://nodejs.org) — wajib untuk build

### Langkah-langkah

**Step 1 — Install Node.js**
Download dan install Node.js LTS dari https://nodejs.org.
Centang opsi *"Add to PATH"* saat instalasi.

**Step 2 — Build installer**
Copy folder `server/` ke PC Windows, lalu double-click **`build.bat`**.
Script akan otomatis install dependencies dan generate file `.exe`:
```
server\dist\ATEM Controller Setup 1.0.0.exe
```

**Step 3 — Jalankan installer**
Double-click `ATEM Controller Setup 1.0.0.exe`.

Jika muncul dialog **"Windows protected your PC"** (SmartScreen):
1. Klik **"More info"**
2. Klik **"Run anyway"**

> SmartScreen muncul karena installer belum ditandatangani Code Signing Certificate. Normal untuk distribusi internal.

**Step 4 — Ikuti wizard**
Klik **Next → Install → Finish**.

**Step 5 — Selesai**
App **ATEM Controller** akan muncul di:
- Start Menu → ATEM Controller
- System Tray (pojok kanan bawah taskbar)

App otomatis berjalan di background dan siap menerima koneksi dari PWA di browser/HP.

---

## 2. Server Build (Developer)

```bash
cd server
npm install
```

### Development
```bash
npm run dev
```

### Build .exe (harus di Windows)
```bash
# Cara 1: pakai build.bat (direkomendasikan)
build.bat

# Cara 2: manual
npm run build
# Output: server/dist/ATEM Controller Setup 1.0.0.exe
```

The NSIS installer will:
- Install the app to Program Files
- Create Desktop + Start Menu shortcuts
- Open port 4000 di Windows Firewall (WebSocket Bridge)
- Register auto-uninstall

### Adding your icon
Place `icon.ico` (256x256) dan `icon.png` (512x512) di `server/assets/`.
Generate dari PNG: https://icoconvert.com

---

## 3. Client Setup (Next.js PWA)

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

## 4. Network Configuration

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

## 5. Socket.io Events Reference

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `server:handshake` | `{ atemIP, serverPort, atemStatus }` | Sent on connect |
| `atem:status` | `{ status, message, ip }` | ATEM connection changes |
| `atem:videoState` | `{ programInput, previewInput, transitionStyle, transitionInProgress, transitionPosition, fadeToBlack, inputLabels }` | ME1 video switcher state |
| `atem:audioState` | `{ channels, master }` | Full audio mixer state |
| `atem:mediaState` | `{ players, stillPool }` | Media pool state |
| `atem:vuMeter` | `{ [chIdx]: { left, right, peakLeft, peakRight } }` | Throttled VU (30fps) |

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `atem:connect` | `{ ip }` | Connect ATEM at IP |
| `atem:disconnect` | — | Disconnect ATEM |
| **Video Switcher** | | |
| `atem:setPreviewInput` | `{ source }` | Set ME1 preview bus |
| `atem:setProgramInput` | `{ source }` | Direct cut to program |
| `atem:performAuto` | — | Fire AUTO transition |
| `atem:performCut` | — | Fire CUT transition |
| `atem:setTransitionStyle` | `{ style }` | 0=Mix, 1=Dip, 2=Wipe |
| `atem:performFTB` | — | Toggle Fade to Black |
| **Audio Mixer** | | |
| `atem:setGain` | `{ index, gain }` | Set channel fader (dB) |
| `atem:setMixOption` | `{ index, mixOption }` | 0=Off, 1=On, 4=AFV |
| `atem:setBalance` | `{ index, balance }` | -1.0 to +1.0 |
| `atem:setMasterGain` | `{ gain }` | Master fader (dB) |
| `atem:setMasterBalance` | `{ balance }` | Master pan |
| **Media Pool** | | |
| `atem:setMediaPlayerStill` | `{ playerIndex, stillIndex }` | Assign still to MP1/MP2 |

### Video Source IDs (ATEM Mini Pro)
| Source | ID |
|--------|----|
| HDMI 1–4 | 1, 2, 3, 4 |
| Media Player 1 | 3010 |
| Media Player 2 | 3020 |
| Black | 0 |
| Color Bars | 1000 |

---

## 6. VU Meter Throttling

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

## 7. PWA Installation

### Android (Chrome)
1. Open `http://[SERVER_IP]:3000` in Chrome
2. Tap "Add to Home Screen" from the menu
3. App launches in fullscreen landscape mode

### iOS (Safari)
1. Open in Safari
2. Share → "Add to Home Screen"
3. App uses `apple-mobile-web-app-capable` for fullscreen

---

## 8. IP Persistence

| Location | What | Storage |
|----------|------|---------|
| Server | ATEM IP, port, runOnStartup | `electron-settings` (JSON, `%APPDATA%`) |
| PWA | Server URL | `localStorage['atem_server_url']` |
| PWA | ATEM IP | `localStorage['atem_ip']` |

On PWA load, both IPs are restored. On `server:handshake`, the server's saved ATEM IP overwrites the PWA's local copy to keep them in sync.
