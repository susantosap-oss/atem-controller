package com.atempwa.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AtemConnection — Implements the ATEM Mini Pro UDP control protocol.
 * Port 9910, proprietary binary protocol.
 *
 * Protocol overview:
 *   - 12-byte packet header + variable payload
 *   - Client initiates with HELLO packet (flag=0x10)
 *   - ATEM responds with session ID
 *   - Client sends ACK for every received packet
 *   - Data packets contain concatenated command blocks (4-byte cmd header + data)
 */
public class AtemConnection {

    private static final String TAG = "AtemConnection";
    private static final int ATEM_PORT = 9910;
    private static final int RECV_BUFFER = 4096;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int RECONNECT_DELAY_MS = 5000;

    // Throttle constants — prevent main-thread flooding
    private static final long VU_EMIT_INTERVAL_MS    = 80;   // max ~12 fps VU meter
    private static final long VIDEO_EMIT_INTERVAL_MS = 50;   // max ~20 fps video state
    private static final long WATCHDOG_TIMEOUT_MS    = 7000; // 7s no data → reconnect

    // Packet flag bits (high nibble of first header byte)
    private static final int FLAG_ACK      = 0x80; // bit7
    private static final int FLAG_HELLO    = 0x10; // bit4 — init/SYN
    private static final int FLAG_RESEND   = 0x20;
    private static final int FLAG_REQ_ACK  = 0x08;

    public interface Listener {
        void onStatus(String status, String message, String ip);
        void onAudioState(JSObject state);
        void onVideoState(JSObject state);
        void onVuMeter(JSObject levels);
        void onMediaState(JSObject state);
    }

    private final String ip;
    private final Listener listener;
    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private DatagramSocket socket;
    private InetAddress atemAddress;
    private volatile boolean running = false;
    private volatile boolean connected = false;
    private volatile boolean initialized = false;

    private int sessionId = 0;
    private final AtomicInteger localPacketId = new AtomicInteger(0);
    private int lastRemotePacketId = 0;

    private Thread receiveThread;
    private ScheduledExecutorService scheduler;
    private ScheduledFuture<?> connectTimeoutFuture;
    private ScheduledFuture<?> reconnectFuture;
    private ScheduledFuture<?> keepAliveFuture;

    // ── ATEM state ────────────────────────────────────────────────
    // Audio channels: key = channel index
    private final Map<Integer, double[]> audioChannels = new HashMap<>(); // [gain, balance, mixOption]
    private final Map<Integer, Long> fairlightSources = new HashMap<>();  // ch → Fairlight source BigInt64
    private volatile boolean isFairlight = false;
    private double masterGain = 0, masterBalance = 0;
    // Video
    private int previewInput = 0, programInput = 0;
    private int transitionStyle = 0;
    private boolean transitionInProgress = false;
    private int transitionPosition = 0;
    private boolean ftbFullyBlack = false, ftbInTransition = false;
    private final boolean[] dskOnAir = {false, false};
    private final boolean[] dskInTransition = {false, false};
    private final int[] dskFillSource = {0, 0};
    private final Map<Integer, String> inputLabels = new HashMap<>();
    // VU levels: key = channel index or -1 for master
    private final Map<Integer, double[]> vuLevels = new HashMap<>();
    // Media: players and still pool
    // players: key=playerIndex, value=[sourceType, stillIndex]
    private final Map<Integer, int[]> mediaPlayers = new HashMap<>();
    // stillPool: key=slotIndex, value=[isUsed(0/1), fileName]
    private final Map<Integer, String[]> stillPool = new HashMap<>();

    // Standard ATEM Mini Pro channel IDs — pre-populated on connect
    private static final int[] ATEM_DEFAULT_CHANNELS = {1, 2, 3, 4, 1301, 1302};

    // Stability: throttle emit timestamps + watchdog
    private volatile long lastPacketReceivedMs = 0;
    private long lastVuEmitMs    = 0;
    private long lastVideoEmitMs = 0;
    private boolean hasLoggedFMLv = false;

    // Keep connection alive when screen off / app in background
    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    public AtemConnection(String ip, Listener listener, Context context) {
        this.ip = ip;
        this.listener = listener;
        this.context = context;
        initInputLabels();
    }

    private void initInputLabels() {
        inputLabels.put(0, "BLK");
        inputLabels.put(1, "CH 1");
        inputLabels.put(2, "CH 2");
        inputLabels.put(3, "CH 3");
        inputLabels.put(4, "CH 4");
        inputLabels.put(3010, "MP 1");
        inputLabels.put(3020, "MP 2");
    }

    public boolean isConnected() { return connected; }

    // ── Connect ───────────────────────────────────────────────────

    public void connect() {
        if (running) disconnect();
        running = true;
        connected = false;
        initialized = false;
        // Clear stale state from previous session
        audioChannels.clear();
        fairlightSources.clear();
        isFairlight = false;
        vuLevels.clear();
        mediaPlayers.clear();
        stillPool.clear();
        dskFillSource[0] = 0; dskFillSource[1] = 0;
        lastPacketReceivedMs = 0;
        lastVuEmitMs    = 0;
        lastVideoEmitMs = 0;
        hasLoggedFMLv   = false;
        hasLoggedFALv   = false;
        hasLoggedRXMS   = false;
        // Pre-populate standard ATEM Mini Pro channels so mixer isn't blank on connect.
        // Real values arrive via FASP when faders change; these are just safe defaults.
        for (int ch : ATEM_DEFAULT_CHANNELS) {
            audioChannels.put(ch, new double[]{0.0, 0.0, 1.0});
        }
        scheduler = Executors.newSingleThreadScheduledExecutor();

        // Prevent WiFi radio from sleeping and CPU from dozing while connected to ATEM
        WifiManager wifiMgr = (WifiManager) context.getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
        if (wifiMgr != null) {
            wifiLock = wifiMgr.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "atem:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
        PowerManager powerMgr = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (powerMgr != null) {
            wakeLock = powerMgr.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "atem:wake");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }

        emitStatus("connecting", "", ip);

        receiveThread = new Thread(this::receiveLoop, "atem-recv");
        receiveThread.setDaemon(true);
        receiveThread.start();

        // Connection timeout
        connectTimeoutFuture = scheduler.schedule(() -> {
            if (!connected) {
                Log.w(TAG, "Connect timeout");
                emitStatus("error", "Connection timeout", ip);
            }
        }, CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS);

        // Keepalive: kirim ACK setiap 500ms supaya session ATEM tidak timeout
        keepAliveFuture = scheduler.scheduleAtFixedRate(() -> {
            if (connected && socket != null && !socket.isClosed()) {
                sendAck(lastRemotePacketId);
            }
        }, 500, 500, TimeUnit.MILLISECONDS);
    }

    public void disconnect() {
        running = false;
        connected = false;
        initialized = false;
        if (connectTimeoutFuture != null) { connectTimeoutFuture.cancel(true); }
        if (reconnectFuture != null) { reconnectFuture.cancel(true); }
        if (keepAliveFuture != null) { keepAliveFuture.cancel(true); }
        if (scheduler != null) { scheduler.shutdownNow(); }
        closeSocket();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        emitStatus("disconnected", "", ip);
    }

    // ── Receive loop ──────────────────────────────────────────────

    private void receiveLoop() {
        try {
            socket = new DatagramSocket();
            socket.setSoTimeout(2000);
            bindSocketToWifi(socket);
            atemAddress = InetAddress.getByName(ip);
            sendHello();

            byte[] buf = new byte[RECV_BUFFER];
            while (running) {
                DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(pkt);
                    processPacket(pkt.getData(), pkt.getLength());
                } catch (java.net.SocketTimeoutException e) {
                    // Normal 2s timeout — check dead connection watchdog
                    if (connected && lastPacketReceivedMs > 0) {
                        long silence = System.currentTimeMillis() - lastPacketReceivedMs;
                        if (silence > WATCHDOG_TIMEOUT_MS) {
                            Log.w(TAG, "Watchdog: no ATEM data for " + silence + "ms, reconnecting");
                            throw new java.io.IOException("Connection stalled");
                        }
                    }
                }
            }
        } catch (Exception e) {
            if (running) {
                Log.e(TAG, "Receive loop error: " + e.getMessage());
                emitStatus("error", e.getMessage(), ip);
                scheduleReconnect();
            }
        } finally {
            closeSocket();
        }
    }

    // ── Packet processing ─────────────────────────────────────────

    private void processPacket(byte[] data, int len) {
        if (len < 12) return;
        ByteBuffer buf = ByteBuffer.wrap(data, 0, len).order(ByteOrder.BIG_ENDIAN);

        int flagsAndLen = buf.getShort(0) & 0xFFFF;
        int flags = (flagsAndLen >> 11) & 0x1F;
        int pktLen = flagsAndLen & 0x07FF;
        if (pktLen < 12) return;
        int pktSession = buf.getShort(2) & 0xFFFF;
        int remoteAckId = buf.getShort(4) & 0xFFFF;
        int localAckId  = buf.getShort(6) & 0xFFFF;
        int remoteId    = buf.getShort(10) & 0xFFFF;

        boolean isHello = (flags & 0x02) != 0;  // SYN/init (FLAG_HELLO=0x10 in pkt[0] → bit1 after >>11)
        boolean isAck   = (flags & 0x10) != 0;  // ACK only packet (FLAG_ACK=0x80 in pkt[0] → bit4 after >>11)

        // Track last received packet time for watchdog (any packet proves connection is alive)
        lastPacketReceivedMs = System.currentTimeMillis();

        if (isHello && sessionId == 0) {
            // ATEM responded to our hello — extract session ID
            sessionId = pktSession;
            Log.d(TAG, "Session established: 0x" + Integer.toHexString(sessionId));
            sendAck(remoteId);
            return;
        }

        if (sessionId == 0) return;

        // ATEM may assign a new session ID for data packets — adopt it and reset state
        if (pktSession != 0 && pktSession != sessionId) {
            Log.d(TAG, "Session update: 0x" + Integer.toHexString(sessionId)
                + " → 0x" + Integer.toHexString(pktSession));
            sessionId = pktSession;
            // Clear stale state to avoid mixing data from two sessions
            audioChannels.clear();
            fairlightSources.clear();
            vuLevels.clear();
            mediaPlayers.clear();
            stillPool.clear();
            isFairlight = false;
            initialized = false;
        }

        // ACK-only packet
        if (isAck) {
            Log.d(TAG, "RX ACK: ATEM acked our pid=" + remoteAckId);
            return;
        }

        // Parse command blocks from payload
        if (pktLen > 12 && len >= pktLen) {
            parseCommands(data, pktLen);
        }

        // Cumulative ACK: only track highest remoteId, always ACK that
        if (remoteId != 0) {
            if (remoteId > lastRemotePacketId) {
                lastRemotePacketId = remoteId;
            }
            sendAck(lastRemotePacketId);
        }

        // Mark fully initialized on first data packet
        if (!initialized && !isHello) {
            initialized = true;
            connected = true;
            if (connectTimeoutFuture != null) connectTimeoutFuture.cancel(false);
            Log.i(TAG, "ATEM connected and initialized, isFairlight=" + isFairlight);
            emitStatus("connected", "", ip);
            emitFullAudioState();
            emitFullVideoState();
            emitMediaState();
            // Request Fairlight VU level streaming — delayed 500ms so ATEM finishes init
            scheduler.schedule(this::requestFairlightLevels, 500, TimeUnit.MILLISECONDS);
        }
    }

    private void parseCommands(byte[] data, int totalLen) {
        int pos = 12; // skip 12-byte header
        boolean audioChanged      = false;
        boolean videoChanged      = false; // important events (PGM/PVW/FTB/DSK/style) — emit immediately
        boolean transitionChanged = false; // TrPs only — throttled (high-frequency flood)
        boolean vuChanged         = false;

        while (pos + 8 <= totalLen) {
            int cmdLen = ((data[pos] & 0xFF) << 8) | (data[pos + 1] & 0xFF);
            if (cmdLen < 8 || cmdLen > 4096 || pos + cmdLen > totalLen) break;

            String cmd = new String(data, pos + 4, 4);
            byte[] payload = new byte[cmdLen - 8];
            System.arraycopy(data, pos + 8, payload, 0, payload.length);

            // Diagnostic: log every command received (adb logcat -s AtemConnection:V)
            Log.v(TAG, "CMD " + cmd + " len=" + cmdLen);

            boolean mediaChanged = false;
            switch (cmd) {
                // ── Legacy audio (older firmware / non-Fairlight models) ──────────
                case "AMIP": parseAudioInputProps(payload);     audioChanged = true; break;
                case "AMMO": parseAudioMasterOutput(payload);   audioChanged = true; break;
                case "AMLv": parseAudioLevels(payload);         vuChanged    = true; break;

                // ── Fairlight audio (ATEM Mini Pro firmware 8.6+) ───────────────
                // FASP = Fairlight Audio Send Properties (channel fader + mixOption)
                case "FASP": parseFairlightSend(payload);        audioChanged = true; break;
                // FAMP = Fairlight Audio Master Properties
                case "FAMP": parseFairlightMaster(payload);      audioChanged = true; break;
                // FAIP = Fairlight Audio Input Properties (registers channel existence)
                case "FAIP": parseFairlightInputProps(payload);  audioChanged = true; break;
                // FMLv = Fairlight Source Levels (channel VU, one packet per source)
                case "FMLv": parseFairlightLevels(payload);      vuChanged    = true; break;
                // FDLv = Fairlight Master Levels
                case "FDLv": parseFairlightMasterLevels(payload);vuChanged    = true; break;
                // FALv / FaLv — possible Fairlight VU (was wrongly ignored)
                case "FALv": parseFairlightAltLevels("FALv", payload); vuChanged = true; break;
                case "FaLv": parseFairlightAltLevels("FaLv", payload); vuChanged = true; break;
                // RXMS — initial send-bus level (not fader gain, ignore quietly)
                case "RXMS": break;
                // AIXP — initial channel fader gain (int16 centidB at bytes 2-3, confirmed from live hex)
                case "AIXP": parseAixp(payload); audioChanged = true; break;
                // FASG — initial sub-source state; save sourceId for CFSP before first FASP
                case "FASG": parseFasg(payload); break;

                // ── Video ───────────────────────────────────────────────────────
                case "PrvI": parsePreviewInput(payload);      videoChanged      = true; break;
                case "PrgI": parseProgramInput(payload);      videoChanged      = true; break;
                case "TrSS": parseTransitionStyle(payload);   videoChanged      = true; break;
                case "TrPs": parseTransitionPosition(payload);transitionChanged = true; break;
                case "FtbS": parseFtbState(payload);          videoChanged      = true; break;
                case "DskS": parseDSKState(payload, 0);       videoChanged      = true; break;
                case "DskP": parseDSKProps(payload);          videoChanged = true;      break;
                case "InPr": parseInputProps(payload);                                  break;

                // ── Media ───────────────────────────────────────────────────────
                case "MPCE":
                    parseMediaPlayerSource(payload); mediaChanged = true; break;
                case "MPfe": parseMediaStillFile(payload); mediaChanged = true; break;

                // ── Fairlight Audio Capabilities — mark as Fairlight mode ────────
                case "_FAC": isFairlight = true; Log.i(TAG, "_FAC received — Fairlight mode ON"); break;

                // ── Known-ignorable (high-frequency or irrelevant) ──────────────
                case "Time": case "TlIn": case "TlSr": case "TlFc": case "Powr":
                case "Warn": case "SaBk": case "FMTl": case "TCOd": case "_ver":
                case "MvIn": case "MvPr": case "SSrc": case "SSBk": case "SSBK":
                case "RCPS": case "RCPs": case "DCPS": case "DCPs": case "CASM":
                case "CASP": case "CAWR": case "CAIP": case "AMVS": case "AMmO":
                // Fairlight ignorable
                case "FaIn": case "FaDy": case "FaEQ": case "FAEC": case "FaAP":
                case "FaMT": case "FaMm": case "FaMV": case "FAMS":
                // Init/capability descriptors (sent once on connect, not actionable)
                case "_pin": case "_top": case "_MeC": case "_mpl": case "_MvC":
                case "_FEC": case "FAOC": case "_VML": case "_VMC":
                case "_MAC": case "_DVE": case "WhoI": case "VidM": case "AiVM":
                case "FEna": case "TcSt": case "TcLk": case "TCCc":
                // Input mapping
                case "InMp":
                // Multiviewer / monitor routing
                case "MvVM": case "MvBC": case "MvOc": case "MvOv":
                case "VuMC": case "VuMo": case "SaMw": case "StMw":
                // Transition parameters (not position — those are TrPs)
                case "TrPr": case "TMxP": case "TDpP": case "TWpP": case "TDvP": case "TStP":
                // Keyer settings
                case "KeOn": case "KeBP": case "KBfT": case "KeLm":
                case "KACk": case "KACC": case "KePt": case "KeDV": case "KeFS": case "KKFP":
                // DSK / FTB parameters
                case "DskB": case "FtbP":
                // Color generator values
                case "ColV":
                // Aux source routing
                case "AuxS":
                // Recording / streaming status (high-frequency, display only on server side)
                case "RTMD": case "RTMS": case "SRSS":
                    break;
                default:
                    Log.i(TAG, "UNKNOWN cmd=" + cmd + " len=" + cmdLen
                        + " hex=" + bytesToHex(payload, Math.min(24, payload.length)));
                    break;
            }
            if (initialized && mediaChanged) emitMediaState();

            pos += cmdLen;
        }

        if (initialized) {
            if (audioChanged) emitFullAudioState();

            // Important video events (PGM/PVW/DSK/FTB/style): always emit immediately
            if (videoChanged) {
                lastVideoEmitMs = System.currentTimeMillis();
                emitFullVideoState();
            } else if (transitionChanged) {
                // TrPs floods at up to 60fps during T-bar drag — throttle to ~20fps
                long nowVideo = System.currentTimeMillis();
                if (nowVideo - lastVideoEmitMs >= VIDEO_EMIT_INTERVAL_MS) {
                    lastVideoEmitMs = nowVideo;
                    emitFullVideoState();
                }
            }

            if (vuChanged) {
                // AMLv floods at ~24fps — throttle to ~12fps to prevent main-thread overload
                long nowVu = System.currentTimeMillis();
                if (nowVu - lastVuEmitMs >= VU_EMIT_INTERVAL_MS) {
                    lastVuEmitMs = nowVu;
                    emitVuMeter();
                }
            }
        }
    }

    // ── State parsers ─────────────────────────────────────────────

    private void parseAudioInputProps(byte[] p) {
        // AMIP — Audio Mixer Input Properties (AudioMixerInputUpdateCommand)
        // Ref: atem-connection v3
        // 0-1:   index (uint16 BE)
        // 8:     mixOption
        // 10-11: gain (uint16 BE, linear 0-65535, 32768=0dB)
        // 12-13: balance (int16 BE, raw/200 = float)
        if (p.length < 14) return;
        int ch      = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int mixOpt  = p[8] & 0xFF;
        int gainRaw = ((p[10] & 0xFF) << 8) | (p[11] & 0xFF);
        int balRaw  = (short)(((p[12] & 0xFF) << 8) | (p[13] & 0xFF));
        double gain    = uInt16ToDecibel(gainRaw);
        double balance = balRaw / 200.0;
        Log.d(TAG, "AMIP ch=" + ch + " mixOpt=" + mixOpt + " gain=" + gain + " bal=" + balance);
        audioChannels.put(ch, new double[]{gain, balance, mixOpt});
    }

    private void parseAudioMasterOutput(byte[] p) {
        // AMMO — Audio Mixer Master Output (AudioMixerMasterUpdateCommand)
        // Ref: atem-connection v3
        // 0-1: gain (uint16 BE, linear, 32768=0dB)
        // 2-3: balance (int16 BE, raw/200 = float)
        if (p.length < 4) return;
        int gainRaw = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int balRaw  = (short)(((p[2] & 0xFF) << 8) | (p[3] & 0xFF));
        masterGain    = uInt16ToDecibel(gainRaw);
        masterBalance = balRaw / 200.0;
    }

    // ── Fairlight audio parsers (ATEM Mini Pro firmware 8.6+) ─────

    private void parseFairlightSend(byte[] p) {
        // FASP — Fairlight Audio Send Properties
        // Layout (confirmed from live ATEM hex dump, len=52):
        //   0-1:   audioSource (uint16 BE)
        //   2-9:   sourceId (BigInt64 BE) — used in CFSP reply
        //   40-41: balance (int16 BE, /200)
        //   44-47: faderGain (int32 BE, centidB)
        //   49:    mixOption (0=off, 1=on, 2=afv)
        if (p.length < 2) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);

        // Auto-detect Fairlight even if _FAC was not received
        if (!isFairlight) {
            isFairlight = true;
            Log.i(TAG, "FASP: Fairlight detected, isFairlight=true");
        }

        double gain    = 0.0;
        double balance = 0.0;
        int    mixOpt  = 1;

        if (p.length >= 48) {
            int faderGainRaw = ((p[44] & 0xFF) << 24) | ((p[45] & 0xFF) << 16)
                             | ((p[46] & 0xFF) << 8)  |  (p[47] & 0xFF);
            gain = faderGainRaw / 100.0;
        }
        if (p.length >= 42) {
            int balRaw = (short)(((p[40] & 0xFF) << 8) | (p[41] & 0xFF));
            balance = balRaw / 200.0;
        }
        if (p.length >= 50) {
            mixOpt = p[49] & 0xFF;
        }

        // Source BigInt64 at bytes 8-15 (matches atem-connection library FairlightMixerSourceUpdateCommand)
        if (p.length >= 16) {
            long src = ((long)(p[8]  & 0xFF) << 56) | ((long)(p[9]  & 0xFF) << 48)
                     | ((long)(p[10] & 0xFF) << 40) | ((long)(p[11] & 0xFF) << 32)
                     | ((long)(p[12] & 0xFF) << 24) | ((long)(p[13] & 0xFF) << 16)
                     | ((long)(p[14] & 0xFF) << 8)  |  (long)(p[15] & 0xFF);
            fairlightSources.put(ch, src);
        }

        long storedSrc = fairlightSources.getOrDefault(ch, -1L);
        Log.d(TAG, "FASP ch=" + ch + " gain=" + gain + " bal=" + balance + " mix=" + mixOpt + " src=0x" + Long.toHexString(storedSrc));
        audioChannels.put(ch, new double[]{gain, balance, mixOpt});
    }

    private void parseFairlightMaster(byte[] p) {
        Log.i(TAG, "FAMP len=" + p.length);
        if (p.length < 17) {
            Log.i(TAG, "FAMP short payload len=" + p.length);
            return;
        }
        int gainRaw32 = ((p[12] & 0xFF) << 24) | ((p[13] & 0xFF) << 16)
                      | ((p[14] & 0xFF) << 8)  |  (p[15] & 0xFF);
        masterGain    = gainRaw32 / 100.0;
        masterBalance = 0.0; // Fairlight master has no balance/pan
        Log.d(TAG, "FAMP faderGain=" + masterGain);
    }

    private void parseFairlightInputProps(byte[] p) {
        if (p.length < 2) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        Log.i(TAG, "FAIP ch=" + ch + " len=" + p.length);
        // Ensure channel exists so it appears in the mixer
        if (!audioChannels.containsKey(ch)) {
            audioChannels.put(ch, new double[]{0.0, 0.0, 1.0}); // gain=0dB, center, ON
        }
    }

    private void parseFairlightLevels(byte[] p) {
        if (p.length < 40) {
            if (!hasLoggedFMLv) Log.i(TAG, "FMLv short len=" + p.length);
            return;
        }
        if (!hasLoggedFMLv) {
            hasLoggedFMLv = true;
            Log.i(TAG, "FMLv first packet len=" + p.length + " raw=" + bytesToHex(p, Math.min(p.length, 48)));
        }
        // 0-7:   source (BigInt64 BE)
        // 8-9:   channel index (uint16 BE)
        // 32-33: leftLevel (int16), 34-35: rightLevel, 36-37: leftPeak, 38-39: rightPeak
        int ch = ((p[8] & 0xFF) << 8) | (p[9] & 0xFF);
        double left      = (short)(((p[32] & 0xFF) << 8) | (p[33] & 0xFF)) / 100.0;
        double right     = (short)(((p[34] & 0xFF) << 8) | (p[35] & 0xFF)) / 100.0;
        double peakLeft  = (short)(((p[36] & 0xFF) << 8) | (p[37] & 0xFF)) / 100.0;
        double peakRight = (short)(((p[38] & 0xFF) << 8) | (p[39] & 0xFF)) / 100.0;
        // Stereo channels send TWO FMLv packets, both with negative source:
        //   left sub-channel:  left=active, right=-100 (silent filler)
        //   right sub-channel: left=-100,   right=active
        // Accumulate per field so both bars update correctly.
        double[] accum = vuLevels.get(ch);
        if (accum == null) {
            accum = new double[]{-60.0, -60.0, -60.0, -60.0};
        }
        if (left  > -90.0) { accum[0] = left;     accum[2] = peakLeft;  }
        if (right > -90.0) { accum[1] = right;    accum[3] = peakRight; }
        vuLevels.put(ch, accum);
    }

    private void parseFairlightMasterLevels(byte[] p) {
        // FDLv — Fairlight Master Levels
        // Ref: atem-connection v3 FairlightMixerMasterLevelsUpdateCommand
        // 20-21: leftLevel  (int16)
        // 22-23: rightLevel (int16)
        // 24-25: leftPeak   (int16)
        // 26-27: rightPeak  (int16)
        if (p.length < 28) return;
        double left      = (short)(((p[20] & 0xFF) << 8) | (p[21] & 0xFF)) / 100.0;
        double right     = (short)(((p[22] & 0xFF) << 8) | (p[23] & 0xFF)) / 100.0;
        double peakLeft  = (short)(((p[24] & 0xFF) << 8) | (p[25] & 0xFF)) / 100.0;
        double peakRight = (short)(((p[26] & 0xFF) << 8) | (p[27] & 0xFF)) / 100.0;
        vuLevels.put(-1, new double[]{left, right, peakLeft, peakRight}); // -1 = master
    }

    private boolean hasLoggedFALv = false;
    private void parseFairlightAltLevels(String cmdName, byte[] p) {
        // FALv / FaLv — suspected Fairlight VU command (was incorrectly ignored).
        // Log first packet to determine layout, then attempt to parse like FMLv.
        if (!hasLoggedFALv) {
            hasLoggedFALv = true;
            Log.i(TAG, cmdName + " first packet len=" + p.length
                + " raw=" + bytesToHex(p, Math.min(p.length, 64)));
        }
        // Attempt FMLv-compatible parse (ch at 8-9, levels at 32-39)
        if (p.length >= 40) {
            int ch = ((p[8] & 0xFF) << 8) | (p[9] & 0xFF);
            double left      = (short)(((p[32] & 0xFF) << 8) | (p[33] & 0xFF)) / 100.0;
            double right     = (short)(((p[34] & 0xFF) << 8) | (p[35] & 0xFF)) / 100.0;
            double peakLeft  = (short)(((p[36] & 0xFF) << 8) | (p[37] & 0xFF)) / 100.0;
            double peakRight = (short)(((p[38] & 0xFF) << 8) | (p[39] & 0xFF)) / 100.0;
            vuLevels.put(ch, new double[]{left, right, peakLeft, peakRight});
        }
    }

    private boolean hasLoggedRXMS = false;
    private void parseRxms(byte[] p) {
        // RXMS — sent on connect for each channel, suspected to contain fader level.
        // Layout hypothesis: 0-1=chIndex, 2-3=faderGain(uint16? centidB?), rest=unknown.
        if (p.length < 4) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        if (!hasLoggedRXMS) {
            hasLoggedRXMS = true;
            Log.i(TAG, "RXMS first ch=" + ch + " len=" + p.length
                + " raw=" + bytesToHex(p, Math.min(p.length, 24)));
        }
        // bytes 2-3: try as signed int16 centidB (fader gain)
        int gainRaw = (short)(((p[2] & 0xFF) << 8) | (p[3] & 0xFF));
        // Only apply if value is in plausible Fairlight fader range (-10000 to +1000 centidB)
        if (gainRaw >= -10000 && gainRaw <= 1000) {
            double gain = gainRaw / 100.0;
            double[] existing = audioChannels.get(ch);
            double balance = existing != null ? existing[1] : 0.0;
            double mixOpt  = existing != null ? existing[2] : 1.0;
            audioChannels.put(ch, new double[]{gain, balance, mixOpt});
            Log.d(TAG, "RXMS ch=" + ch + " gain=" + gain);
        }
    }

    private void parseAixp(byte[] p) {
        if (p.length < 4) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int gainRaw = (short)(((p[2] & 0xFF) << 8) | (p[3] & 0xFF));
        if (gainRaw < -10000 || gainRaw > 1000) return;
        double gain = gainRaw / 100.0;
        double[] existing = audioChannels.get(ch);
        double balance = existing != null ? existing[1] : 0.0;
        double mixOpt  = existing != null ? existing[2] : 1.0;
        audioChannels.put(ch, new double[]{gain, balance, mixOpt});
        Log.i(TAG, "AIXP ch=" + ch + " gain=" + gain);
    }

    private void parseFasg(byte[] p) {
        if (p.length < 16) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        if (!fairlightSources.containsKey(ch)) {
            long src = ((long)(p[8]  & 0xFF) << 56) | ((long)(p[9]  & 0xFF) << 48)
                     | ((long)(p[10] & 0xFF) << 40) | ((long)(p[11] & 0xFF) << 32)
                     | ((long)(p[12] & 0xFF) << 24) | ((long)(p[13] & 0xFF) << 16)
                     | ((long)(p[14] & 0xFF) << 8)  |  (long)(p[15] & 0xFF);
            fairlightSources.put(ch, src);
            Log.d(TAG, "FASG ch=" + ch + " src=" + src);
        }
    }

    private void parseAudioLevels(byte[] p) {
        // AMLv structure: first 4 bytes = count of channel entries
        // Then per-channel: 2-byte ch index + levels data
        // Simplified: try to parse what we can
        if (p.length < 4) return;
        int numSources = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int offset = 4;
        for (int i = 0; i < numSources && offset + 4 <= p.length; i++) {
            int ch = ((p[offset] & 0xFF) << 8) | (p[offset + 1] & 0xFF);
            if (offset + 4 <= p.length) {
                // left/right levels as signed 16-bit, units = 1/256 dB
                int leftRaw  = (short)(((p[offset + 2] & 0xFF) << 8) | (p[offset + 3] & 0xFF));
                int rightRaw = (p.length > offset + 5)
                    ? (short)(((p[offset + 4] & 0xFF) << 8) | (p[offset + 5] & 0xFF))
                    : leftRaw;
                double left  = leftRaw  / 256.0;
                double right = rightRaw / 256.0;
                vuLevels.put(ch, new double[]{left, right, left, right});
            }
            offset += 16; // approximate per-entry size
        }
    }

    private void parsePreviewInput(byte[] p) {
        if (p.length < 4) return;
        previewInput = ((p[2] & 0xFF) << 8) | (p[3] & 0xFF);
    }

    private void parseProgramInput(byte[] p) {
        if (p.length < 4) return;
        programInput = ((p[2] & 0xFF) << 8) | (p[3] & 0xFF);
    }

    private void parseTransitionStyle(byte[] p) {
        // TrSS: ME(1) + style(1) + nextStyle(1) + nextSelection(1)
        if (p.length < 2) return;
        transitionStyle = p[1] & 0xFF;
    }

    private void parseTransitionPosition(byte[] p) {
        // TrPs: ME(1) + inTransition(1) + position(2)
        if (p.length < 4) return;
        transitionInProgress = (p[1] & 0xFF) != 0;
        transitionPosition   = ((p[2] & 0xFF) << 8) | (p[3] & 0xFF);
    }

    private void parseFtbState(byte[] p) {
        // FtbS: ME(1) + isFullyBlack(1) + inTransition(1) + pad(1)
        if (p.length < 3) return;
        ftbFullyBlack   = (p[1] & 0xFF) != 0;
        ftbInTransition = (p[2] & 0xFF) != 0;
    }

    private void parseDSKState(byte[] p, int offset) {
        if (p.length < 4) return;
        int idx = p[0] & 0xFF;
        if (idx < 2) {
            dskOnAir[idx]         = (p[1] & 0x01) != 0;
            dskInTransition[idx]  = (p[1] & 0x02) != 0;
        }
    }

    private void parseDSKProps(byte[] p) {
        // DskP: keyerIndex(1) + preMultiply(1) + clip(2) + gain(2) + invert(1) + pad(1)
        //        fillSource(2) + cutSource(2) + ...
        // fillSource at bytes 8-9, cutSource at bytes 10-11
        if (p.length < 2) return;
        int idx = p[0] & 0xFF;
        if (idx >= 2) return;
        if (p.length >= 10) {
            dskFillSource[idx] = ((p[8] & 0xFF) << 8) | (p[9] & 0xFF);
            Log.d(TAG, "DskP keyer=" + idx + " fillSource=" + dskFillSource[idx]);
        }
    }

    private void parseMediaPlayerSource(byte[] p) {
        // MPLP: playerIndex(1) + sourceType(1) + stillIndex(1) + clipIndex(1)
        if (p.length < 4) return;
        int player     = p[0] & 0xFF;
        int sourceType = p[1] & 0xFF;  // 1=still, 2=clip
        int stillIndex = p[2] & 0xFF;
        mediaPlayers.put(player, new int[]{sourceType, stillIndex});
        Log.d(TAG, "MPLP player=" + player + " type=" + sourceType + " still=" + stillIndex);
    }

    private void parseMediaStillFile(byte[] p) {
        // MPfe — Media Pool Frame Description
        // Ref: atem-connection v3 MediaPoolFrameDescriptionCommand
        // 0:    mediaPool (0=still, 1+=clip)
        // 1:    (padding)
        // 2-3:  frameIndex (uint16 BE)
        // 4:    isUsed (uint8, 1=used)
        // 5-20: hash (16 bytes) — ignored
        // 23:   fileName length (Pascal string prefix)
        // 24+:  fileName data
        if (p.length < 5) return;
        int mediaPool = p[0] & 0xFF;
        if (mediaPool != 0) return; // only still pool (not clip)
        int slot  = ((p[2] & 0xFF) << 8) | (p[3] & 0xFF);
        boolean used = (p[4] & 0xFF) == 1;
        String name = "";
        if (used && p.length > 24) {
            int nameLen = p[23] & 0xFF;
            int maxEnd  = Math.min(24 + nameLen, p.length);
            int end     = 24;
            while (end < maxEnd && p[end] != 0) end++;
            name = new String(p, 24, end - 24);
        }
        stillPool.put(slot, new String[]{used ? "1" : "0", name});
        Log.d(TAG, "MPfe slot=" + slot + " used=" + used + " name=" + name);
    }

    private void parseInputProps(byte[] p) {
        // InPr layout: source(2) + longName(20) + shortName(4) + ...
        if (p.length < 26) return;
        int src = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        // shortName at offset 22, 4 chars
        String name = new String(p, 22, 4).trim().replace("\0", "");
        if (!name.isEmpty()) inputLabels.put(src, name);
    }

    // ── State emitters ─────────────────────────────────────────────

    private void emitFullAudioState() {
        try {
            JSObject channels = new JSObject();
            for (Map.Entry<Integer, double[]> e : audioChannels.entrySet()) {
                double[] v = e.getValue();
                JSObject ch = new JSObject();
                ch.put("gain", v[0]);
                ch.put("balance", v[1]);
                ch.put("mixOption", (int) v[2]);
                ch.put("label", getChannelLabel(e.getKey()));
                channels.put(String.valueOf(e.getKey()), ch);
            }
            JSObject master = new JSObject();
            master.put("gain", masterGain);
            master.put("balance", masterBalance);
            master.put("followFadeToBlack", false);

            JSObject state = new JSObject();
            state.put("channels", channels);
            state.put("master", master);
            mainHandler.post(() -> listener.onAudioState(state));
        } catch (Exception e) {
            Log.e(TAG, "emitFullAudioState: " + e.getMessage());
        }
    }

    private void emitFullVideoState() {
        try {
            JSObject ftb = new JSObject();
            ftb.put("isFullyBlack", ftbFullyBlack);
            ftb.put("inTransition", ftbInTransition);

            JSArray dsk = new JSArray();
            for (int i = 0; i < 2; i++) {
                JSObject d = new JSObject();
                d.put("onAir", dskOnAir[i]);
                d.put("inTransition", dskInTransition[i]);
                d.put("autoRate", 25);
                d.put("fillSource", dskFillSource[i]);
                d.put("cutSource", 0);
                dsk.put(d);
            }

            JSObject labels = new JSObject();
            for (Map.Entry<Integer, String> e : inputLabels.entrySet()) {
                labels.put(String.valueOf(e.getKey()), e.getValue());
            }

            JSObject state = new JSObject();
            state.put("programInput", programInput);
            state.put("previewInput", previewInput);
            state.put("transitionStyle", transitionStyle);
            state.put("transitionInProgress", transitionInProgress);
            state.put("transitionPosition", transitionPosition);
            state.put("fadeToBlack", ftb);
            state.put("dsk", dsk);
            state.put("inputLabels", labels);
            mainHandler.post(() -> listener.onVideoState(state));
        } catch (Exception e) {
            Log.e(TAG, "emitFullVideoState: " + e.getMessage());
        }
    }

    private void emitVuMeter() {
        try {
            JSObject levels = new JSObject();
            for (Map.Entry<Integer, double[]> e : vuLevels.entrySet()) {
                double[] v = e.getValue();
                JSObject l = new JSObject();
                l.put("left", v[0]);
                l.put("right", v[1]);
                l.put("peakLeft", v[2]);
                l.put("peakRight", v[3]);
                String key = e.getKey() < 0 ? "master" : String.valueOf(e.getKey());
                levels.put(key, l);
            }
            mainHandler.post(() -> listener.onVuMeter(levels));
        } catch (Exception e) {
            Log.e(TAG, "emitVuMeter: " + e.getMessage());
        }
    }

    private void emitMediaState() {
        try {
            int usedCount = 0;
            JSObject players = new JSObject();
            for (Map.Entry<Integer, int[]> e : mediaPlayers.entrySet()) {
                int[] v = e.getValue();
                JSObject p = new JSObject();
                p.put("sourceType", v[0]);
                p.put("stillIndex", v[1]);
                p.put("playing", false);
                p.put("loop", false);
                players.put(String.valueOf(e.getKey()), p);
            }
            JSObject pool = new JSObject();
            for (Map.Entry<Integer, String[]> e : stillPool.entrySet()) {
                String[] v = e.getValue();
                boolean isUsed = "1".equals(v[0]);
                if (isUsed) usedCount++;
                JSObject s = new JSObject();
                s.put("isUsed", isUsed);
                s.put("fileName", v[1]);
                pool.put(String.valueOf(e.getKey()), s);
            }
            Log.d(TAG, "emitMediaState: stillPool.size=" + stillPool.size() + " used=" + usedCount);
            JSObject state = new JSObject();
            state.put("players", players);
            state.put("stillPool", pool);
            mainHandler.post(() -> listener.onMediaState(state));
        } catch (Exception e) {
            Log.e(TAG, "emitMediaState: " + e.getMessage());
        }
    }

    private void emitStatus(String status, String message, String ip) {
        mainHandler.post(() -> listener.onStatus(status, message, ip));
    }

    // ── Network binding ───────────────────────────────────────────

    private void bindSocketToWifi(DatagramSocket sock) {
        try {
            ConnectivityManager cm = (ConnectivityManager)
                context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            for (Network net : cm.getAllNetworks()) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(net);
                if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    net.bindSocket(sock);
                    Log.d(TAG, "Socket bound to WiFi network");
                    return;
                }
            }
            Log.w(TAG, "No WiFi network found — using default routing");
        } catch (Exception e) {
            Log.w(TAG, "bindSocketToWifi failed: " + e.getMessage());
        }
    }

    // ── Send helpers ──────────────────────────────────────────────

    private void sendHello() throws Exception {
        // 20-byte hello packet — must match atem-connection library exactly so ATEM
        // sends full Fairlight state (byte 9 = 0x3A signals protocol capability).
        byte[] pkt = new byte[]{
            0x10, 0x14, 0x53, (byte)0xAB,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x3A, 0x00, 0x00,
            0x01, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00
        };
        send(pkt);
    }

    private void sendAck(int remotePacketId) {
        if (socket == null || socket.isClosed()) return;
        try {
            byte[] pkt = new byte[12];
            int sid = sessionId;
            // flags=ACK (0x80), length=12
            pkt[0] = (byte)0x80; pkt[1] = 0x0C;
            pkt[2] = (byte)((sid >> 8) & 0xFF); pkt[3] = (byte)(sid & 0xFF);
            pkt[4] = (byte)((remotePacketId >> 8) & 0xFF); pkt[5] = (byte)(remotePacketId & 0xFF);
            send(pkt);
        } catch (Exception e) {
            Log.w(TAG, "sendAck error: " + e.getMessage());
        }
    }

    private synchronized void sendCommand(byte[] cmdData) {
        if (socket == null || socket.isClosed()) {
            Log.w(TAG, "sendCommand: socket null/closed");
            return;
        }
        if (!connected) {
            Log.w(TAG, "sendCommand: not connected");
            return;
        }
        try {
            int pid = localPacketId.incrementAndGet() & 0x7FFF;
            int totalLen = 12 + cmdData.length;
            byte[] pkt = new byte[totalLen];
            int sid = sessionId;
            // flags=0x01 (has_data), length in 11 low bits
            // ATEM header: [0-1]=flags+len, [2-3]=sessionId, [4-5]=ackId(0), [6-9]=reserved, [10-11]=localPacketId
            pkt[0] = (byte)(0x08 | ((totalLen >> 8) & 0x07));
            pkt[1] = (byte)(totalLen & 0xFF);
            pkt[2] = (byte)((sid >> 8) & 0xFF); pkt[3] = (byte)(sid & 0xFF);
            // pkt[4-9] = 0 (no piggyback ACK, reserved)
            pkt[10] = (byte)((pid >> 8) & 0xFF); pkt[11] = (byte)(pid & 0xFF);
            System.arraycopy(cmdData, 0, pkt, 12, cmdData.length);
            // Log command name for debugging
            if (cmdData.length >= 4) {
                String cmdName = new String(cmdData, 4, Math.min(4, cmdData.length - 4));
                Log.d(TAG, "sendCommand: cmd=" + cmdName + " pid=" + pid + " sid=0x" + Integer.toHexString(sid) + " ack=" + lastRemotePacketId + " len=" + totalLen);
            }
            send(pkt);
        } catch (Exception e) {
            Log.w(TAG, "sendCommand error: " + e.getMessage());
        }
    }

    private void send(byte[] data) throws Exception {
        DatagramPacket pkt = new DatagramPacket(data, data.length, atemAddress, ATEM_PORT);
        socket.send(pkt);
    }

    // ── ATEM Commands ─────────────────────────────────────────────
    // Commands: 8-byte cmd header (2=len, 2=flags, 4=name) + payload

    private byte[] makeCmd(String name, byte[] payload) {
        int len = 8 + payload.length;
        byte[] cmd = new byte[len];
        cmd[0] = (byte)((len >> 8) & 0xFF);
        cmd[1] = (byte)(len & 0xFF);
        // cmd[2..3] = 0 (flags)
        byte[] n = name.getBytes();
        System.arraycopy(n, 0, cmd, 4, Math.min(4, n.length));
        System.arraycopy(payload, 0, cmd, 8, payload.length);
        return cmd;
    }

    // ── Audio conversion helpers ──────────────────────────────────

    private static double uInt16ToDecibel(int val) {
        if (val <= 0) return -100.0;
        return Math.round(Math.log10(val / 32768.0) * 20.0 * 100.0) / 100.0;
    }

    private static int decibelToUInt16(double dB) {
        return (int) Math.floor(Math.pow(10.0, dB / 20.0) * 32768.0);
    }

    // ── Audio channel commands ────────────────────────────────────

    public void sendAudioInputGain(int ch, double gain) {
        if (isFairlight) {
            // CFSP mask: faderGain = 1<<7 = 0x0080
            sendFairlightSourceProps(ch, 0x0080, 0, 0, (int)Math.round(gain * 100), 0);
        } else {
            // CAMI mask: gain = 1<<1 = 0x02
            int gainRaw = decibelToUInt16(gain);
            byte[] p = new byte[12];
            p[0] = 0x02;
            p[2] = (byte)((ch >> 8) & 0xFF); p[3] = (byte)(ch & 0xFF);
            p[6] = (byte)((gainRaw >> 8) & 0xFF); p[7] = (byte)(gainRaw & 0xFF);
            sendCommand(makeCmd("CAMI", p));
        }
    }

    public void sendAudioInputMixOption(int ch, int mixOption) {
        if (isFairlight) {
            // CFSP mask: mixOption = 1<<8 = 0x0100
            sendFairlightSourceProps(ch, 0x0100, mixOption, 0, 0, 0);
        } else {
            // CAMI mask: mixOption = 1<<0 = 0x01
            byte[] p = new byte[12];
            p[0] = 0x01;
            p[2] = (byte)((ch >> 8) & 0xFF); p[3] = (byte)(ch & 0xFF);
            p[4] = (byte)(mixOption & 0xFF);
            sendCommand(makeCmd("CAMI", p));
        }
    }

    public void sendAudioInputBalance(int ch, double balance) {
        if (isFairlight) {
            // CFSP mask: balance = 1<<6 = 0x0040
            sendFairlightSourceProps(ch, 0x0040, 0, (int)Math.round(balance * 200), 0, 0);
        } else {
            // CAMI mask: balance = 1<<2 = 0x04
            int balRaw = (int)Math.round(balance * 200);
            byte[] p = new byte[12];
            p[0] = 0x04;
            p[2] = (byte)((ch >> 8) & 0xFF); p[3] = (byte)(ch & 0xFF);
            p[8] = (byte)((balRaw >> 8) & 0xFF); p[9] = (byte)(balRaw & 0xFF);
            sendCommand(makeCmd("CAMI", p));
        }
    }

    private void requestFairlightLevels() {
        if (!connected || !isFairlight) {
            Log.i(TAG, "requestFairlightLevels skipped: connected=" + connected + " isFairlight=" + isFairlight);
            return;
        }
        Log.i(TAG, "Sending SFLN — requesting Fairlight level streaming");
        // SFLN: 4-byte payload, byte 0 = 1 (enable level updates)
        sendCommand(makeCmd("SFLN", new byte[]{1, 0, 0, 0}));
    }

    private void sendFairlightSourceProps(int ch, int mask, int mixOption, int balance, int faderGain, int flags) {
        // CFSP: 48-byte payload
        // 0-1:   mask (uint16 BE)
        // 2-3:   channel index (uint16 BE)
        // 8-15:  source (BigInt64 BE)
        // 36-37: balance (int16 BE)
        // 40-43: faderGain (int32 BE, centidB)
        // 44:    mixOption
        long src = fairlightSources.getOrDefault(ch, 0L);
        Log.i(TAG, "CFSP ch=" + ch + " mask=0x" + Integer.toHexString(mask) + " faderGain=" + faderGain + " src=0x" + Long.toHexString(src));
        byte[] p = new byte[48];
        p[0] = (byte)((mask >> 8) & 0xFF); p[1] = (byte)(mask & 0xFF);
        p[2] = (byte)((ch >> 8) & 0xFF);   p[3] = (byte)(ch & 0xFF);
        // source at bytes 8-15
        for (int i = 0; i < 8; i++) p[8 + i] = (byte)((src >> (56 - i * 8)) & 0xFF);
        // balance at 36-37
        p[36] = (byte)((balance >> 8) & 0xFF); p[37] = (byte)(balance & 0xFF);
        // faderGain at 40-43
        p[40] = (byte)((faderGain >> 24) & 0xFF); p[41] = (byte)((faderGain >> 16) & 0xFF);
        p[42] = (byte)((faderGain >> 8) & 0xFF);  p[43] = (byte)(faderGain & 0xFF);
        // mixOption at 44
        p[44] = (byte)(mixOption & 0xFF);
        sendCommand(makeCmd("CFSP", p));
    }

    public void sendMasterGain(double gain) {
        if (isFairlight) {
            // CFMP mask: faderGain = 1<<3 = 0x08; faderGain at bytes 12-15 (int32 BE centidB)
            byte[] p = new byte[20];
            p[0] = 0x08;
            int gainCenti = (int)Math.round(gain * 100);
            p[12] = (byte)((gainCenti >> 24) & 0xFF); p[13] = (byte)((gainCenti >> 16) & 0xFF);
            p[14] = (byte)((gainCenti >> 8) & 0xFF);  p[15] = (byte)(gainCenti & 0xFF);
            sendCommand(makeCmd("CFMP", p));
        } else {
            // CAMM mask: gain = 1<<0 = 0x01; gain at bytes 2-3 (uint16 BE DecibelToUInt16)
            int gainRaw = decibelToUInt16(gain);
            byte[] p = new byte[8];
            p[0] = 0x01;
            p[2] = (byte)((gainRaw >> 8) & 0xFF); p[3] = (byte)(gainRaw & 0xFF);
            sendCommand(makeCmd("CAMM", p));
        }
    }

    public void sendMasterBalance(double balance) {
        if (!isFairlight) {
            // CAMM mask: balance = 1<<1 = 0x02; balance at bytes 4-5 (int16 BE)
            int balRaw = (int)Math.round(balance * 200);
            byte[] p = new byte[8];
            p[0] = 0x02;
            p[4] = (byte)((balRaw >> 8) & 0xFF); p[5] = (byte)(balRaw & 0xFF);
            sendCommand(makeCmd("CAMM", p));
        }
        // Fairlight master has no balance
    }

    public void sendPreviewInput(int source) {
        // CPvI: ME(1) + pad(1) + source(2)
        byte[] p = new byte[4];
        p[2] = (byte)((source >> 8) & 0xFF); p[3] = (byte)(source & 0xFF);
        sendCommand(makeCmd("CPvI", p));
    }

    public void sendProgramInput(int source) {
        // CPgI: ME(1) + pad(1) + source(2)
        byte[] p = new byte[4];
        p[2] = (byte)((source >> 8) & 0xFF); p[3] = (byte)(source & 0xFF);
        sendCommand(makeCmd("CPgI", p));
    }

    public void sendAutoTransition() {
        // CTMx: set Mix rate = 25 frames (1 detik @ 25fps / ~0.83s @ 30fps)
        // ME(1) + rate(1) + pad(2)
        sendCommand(makeCmd("CTMx", new byte[]{0, 25, 0, 0}));
        // DAut: ME(1) + pad(3)
        sendCommand(makeCmd("DAut", new byte[]{0, 0, 0, 0}));
    }

    public void sendCut() {
        // DCut: ME(1) + pad(3)
        sendCommand(makeCmd("DCut", new byte[]{0, 0, 0, 0}));
    }

    public void sendTransitionStyle(int style) {
        // CTTp: mask(1) + ME(1) + nextStyle(1) + nextSelection(1)
        byte[] p = new byte[4];
        p[0] = 0x01; // mask: style
        p[2] = (byte)(style & 0xFF);
        sendCommand(makeCmd("CTTp", p));
    }

    public void sendTransitionPosition(int position) {
        // CTPs: ME(1) + pad(1) + position(2, 0-9999)
        byte[] p = new byte[4];
        p[2] = (byte)((position >> 8) & 0xFF); p[3] = (byte)(position & 0xFF);
        sendCommand(makeCmd("CTPs", p));
    }

    public void sendFadeToBlack() {
        // FtbA: ME(1) + pad(3)
        sendCommand(makeCmd("FtbA", new byte[]{0, 0, 0, 0}));
    }

    public void sendDSKOnAir(int keyerIndex, boolean onAir) {
        // CDsA: keyerIndex(1) + onAir(1) + pad(2)
        byte[] p = new byte[4];
        p[0] = (byte)(keyerIndex & 0xFF);
        p[1] = (byte)(onAir ? 1 : 0);
        Log.i(TAG, "sendDSKOnAir keyer=" + keyerIndex + " onAir=" + onAir);
        sendCommand(makeCmd("CDsA", p));
    }

    public void sendAutoDSK(int keyerIndex) {
        // CDsT: keyerIndex(1) + pad(3)
        byte[] p = new byte[4];
        p[0] = (byte)(keyerIndex & 0xFF);
        sendCommand(makeCmd("CDsT", p));
    }

    public void sendMediaPlayerSource(int playerIndex, int stillIndex) {
        // MPSS payload (8 bytes):
        //   0: mask  — bit0=sourceType, bit1=stillIndex, bit2=clipIndex
        //   1: playerIndex
        //   2: sourceType (1=still)
        //   3: stillIndex
        //   4: clipIndex (0)
        //   5-7: padding
        byte[] p = new byte[8];
        p[0] = 0x03; // mask: set sourceType + stillIndex
        p[1] = (byte)(playerIndex & 0xFF);
        p[2] = 0x01; // sourceType = still
        p[3] = (byte)(stillIndex & 0xFF);
        Log.i(TAG, "sendMediaPlayerSource player=" + playerIndex + " still=" + stillIndex);
        sendCommand(makeCmd("MPSS", p));
    }

    // ── Helpers ───────────────────────────────────────────────────

    private static String bytesToHex(byte[] b, int len) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < len && i < b.length; i++) {
            if (i > 0) sb.append(' ');
            sb.append(String.format("%02X", b[i] & 0xFF));
        }
        return sb.toString();
    }

    private String getChannelLabel(int idx) {
        String label = inputLabels.get(idx);
        if (label != null) return label;
        switch (idx) {
            case 1301: return "MIC 1";
            case 1302: return "MIC 2";
            case 2001: return "XLR 1";
            case 2002: return "XLR 2";
            default:
                if (idx >= 1 && idx <= 8) return "HDMI " + idx;
                return "CH " + idx;
        }
    }

    private void closeSocket() {
        if (socket != null && !socket.isClosed()) {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private void scheduleReconnect() {
        if (scheduler == null || scheduler.isShutdown()) return;
        reconnectFuture = scheduler.schedule(() -> {
            if (running) {
                Log.i(TAG, "Reconnecting...");
                // Interrupt stale thread before starting fresh to prevent thread leak
                Thread old = receiveThread;
                if (old != null && old.isAlive()) {
                    old.interrupt();
                    try { old.join(1000); } catch (InterruptedException ignored) {}
                }
                receiveThread = new Thread(this::receiveLoop, "atem-recv");
                receiveThread.setDaemon(true);
                receiveThread.start();
            }
        }, RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS);
    }
}
