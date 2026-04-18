package com.atempwa.app;

import android.os.Handler;
import android.os.Looper;
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
    private double masterGain = 0, masterBalance = 0;
    // Video
    private int previewInput = 0, programInput = 0;
    private int transitionStyle = 0;
    private boolean transitionInProgress = false;
    private int transitionPosition = 0;
    private boolean ftbFullyBlack = false, ftbInTransition = false;
    private final boolean[] dskOnAir = {false, false};
    private final boolean[] dskInTransition = {false, false};
    private final Map<Integer, String> inputLabels = new HashMap<>();
    // VU levels: key = channel index or -1 for master
    private final Map<Integer, double[]> vuLevels = new HashMap<>();
    // Media: players and still pool
    // players: key=playerIndex, value=[sourceType, stillIndex]
    private final Map<Integer, int[]> mediaPlayers = new HashMap<>();
    // stillPool: key=slotIndex, value=[isUsed(0/1), fileName]
    private final Map<Integer, String[]> stillPool = new HashMap<>();

    // Stability: throttle emit timestamps + watchdog
    private volatile long lastPacketReceivedMs = 0;
    private long lastVuEmitMs    = 0;
    private long lastVideoEmitMs = 0;

    public AtemConnection(String ip, Listener listener) {
        this.ip = ip;
        this.listener = listener;
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
        vuLevels.clear();
        mediaPlayers.clear();
        stillPool.clear();
        lastPacketReceivedMs = 0;
        lastVuEmitMs    = 0;
        lastVideoEmitMs = 0;
        scheduler = Executors.newSingleThreadScheduledExecutor();

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
        emitStatus("disconnected", "", ip);
    }

    // ── Receive loop ──────────────────────────────────────────────

    private void receiveLoop() {
        try {
            socket = new DatagramSocket();
            socket.setSoTimeout(2000);
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
        int pktSession = buf.getShort(2) & 0xFFFF;
        int remoteAckId = buf.getShort(4) & 0xFFFF;
        int localAckId  = buf.getShort(6) & 0xFFFF;
        int remoteId    = buf.getShort(10) & 0xFFFF;

        boolean isHello = (flags & 0x02) != 0;  // SYN/init (FLAG_HELLO=0x10 in pkt[0] → bit1 after >>11)
        boolean isAck   = (flags & 0x10) != 0;  // ACK only packet (FLAG_ACK=0x80 in pkt[0] → bit4 after >>11)

        // Track last received packet time for watchdog (skip pure ACK-only to reduce noise)
        if (!isAck) lastPacketReceivedMs = System.currentTimeMillis();

        if (isHello && sessionId == 0) {
            // ATEM responded to our hello — extract session ID
            sessionId = pktSession;
            Log.d(TAG, "Session established: 0x" + Integer.toHexString(sessionId));
            sendAck(remoteId);
            return;
        }

        if (sessionId == 0) return;

        // ATEM may assign a new session ID for data packets — adopt it
        if (pktSession != 0 && pktSession != sessionId) {
            Log.d(TAG, "Session update: 0x" + Integer.toHexString(sessionId)
                + " → 0x" + Integer.toHexString(pktSession));
            sessionId = pktSession;
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
            Log.i(TAG, "ATEM connected and initialized");
            emitStatus("connected", "", ip);
            emitFullAudioState();
            emitFullVideoState();
            emitMediaState();
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
            if (cmdLen < 8 || pos + cmdLen > totalLen) break;

            String cmd = new String(data, pos + 4, 4);
            byte[] payload = new byte[cmdLen - 8];
            System.arraycopy(data, pos + 8, payload, 0, payload.length);

            // Diagnostic: log every command received (adb logcat -s AtemConnection:V)
            Log.v(TAG, "CMD " + cmd + " len=" + cmdLen);

            boolean mediaChanged = false;
            switch (cmd) {
                // ── Legacy audio (older firmware / non-Fairlight models) ──────────
                case "AMIP": parseAudioInputProps(payload);     audioChanged = true; break;
                case "AMmO": parseAudioMasterOutput(payload);   audioChanged = true; break;
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

                // ── Video ───────────────────────────────────────────────────────
                case "PrvI": parsePreviewInput(payload);      videoChanged      = true; break;
                case "PrgI": parseProgramInput(payload);      videoChanged      = true; break;
                case "TrSS": parseTransitionStyle(payload);   videoChanged      = true; break;
                case "TrPs": parseTransitionPosition(payload);transitionChanged = true; break;
                case "FtbS": parseFtbState(payload);          videoChanged      = true; break;
                case "DskS": parseDSKState(payload, 0);       videoChanged      = true; break;
                case "DskP": parseDSKProps(payload);                                    break;
                case "InPr": parseInputProps(payload);                                  break;

                // ── Media ───────────────────────────────────────────────────────
                case "MPCE":
                    parseMediaPlayerSource(payload); mediaChanged = true; break;
                case "MPfe": parseMediaStillFile(payload); mediaChanged = true; break;

                // ── Known-ignorable (high-frequency or irrelevant) ──────────────
                case "Time": case "TlIn": case "TlSr": case "TlFc": case "Powr":
                case "Warn": case "SaBk": case "FMTl": case "TCOd": case "_ver":
                case "MvIn": case "MvPr": case "SSrc": case "SSBk": case "SSBK":
                case "RCPS": case "RCPs": case "DCPS": case "DCPs": case "CASM":
                case "CASP": case "CAWR": case "CAIP": case "AMMO": case "AMVS":
                // Fairlight ignorable
                case "FaIn": case "FaDy": case "FaEQ": case "FAEC": case "FaAP":
                case "FaMT": case "FaMm": case "FaMV": case "FAMS": case "FALv":
                case "FaLv":
                // Init/capability descriptors (sent once on connect, not actionable)
                case "_pin": case "_top": case "_MeC": case "_mpl": case "_MvC":
                case "_FAC": case "_FEC": case "FAOC": case "_VML": case "_VMC":
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
                    // Log first 8 bytes as hex to help identify unknown commands
                    Log.i(TAG, "UNKNOWN cmd=" + cmd + " len=" + cmdLen
                        + " hex=" + bytesToHex(payload, Math.min(8, payload.length)));
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
        // AMIP (legacy audio): channel(2) + mixOption(1) + direction(1) + gain(2) + balance(2)
        if (p.length < 8) return;
        int ch      = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int mixOpt  = p[2] & 0xFF;
        int gainRaw = (short)(((p[4] & 0xFF) << 8) | (p[5] & 0xFF));
        int balRaw  = (short)(((p[6] & 0xFF) << 8) | (p[7] & 0xFF));
        double gain    = gainRaw / 256.0;
        double balance = balRaw / 10000.0;
        Log.d(TAG, "AMIP ch=" + ch + " mixOpt=" + mixOpt + " gain=" + gain + " bal=" + balance);
        audioChannels.put(ch, new double[]{gain, balance, mixOpt});
    }

    private void parseAudioMasterOutput(byte[] p) {
        // AMmO (legacy audio): gain(2) + balance(2) + ...
        if (p.length < 4) return;
        int gainRaw = (short)(((p[0] & 0xFF) << 8) | (p[1] & 0xFF));
        int balRaw  = (short)(((p[2] & 0xFF) << 8) | (p[3] & 0xFF));
        masterGain    = gainRaw / 256.0;
        masterBalance = balRaw / 10000.0;
    }

    // ── Fairlight audio parsers (ATEM Mini Pro firmware 8.6+) ─────

    private void parseFairlightSend(byte[] p) {
        // FASP — Fairlight Audio Send Properties
        // Ref: atem-connection v3 FairlightMixerSourceUpdateCommand
        // 0-1:   index (audioSource, uint16 BE)  — channel ID
        // 8-15:  source (BigInt64 BE)             — sub-source ID (skip)
        // 40-41: balance (int16 BE)
        // 44-47: faderGain (int32 BE, centidB)    — fader position
        // 49:    mixOption (0=off, 1=on, 2=afv)
        if (p.length < 50) {
            Log.d(TAG, "FASP short payload len=" + p.length);
            return;
        }
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int faderGainRaw = ((p[44] & 0xFF) << 24) | ((p[45] & 0xFF) << 16)
                         | ((p[46] & 0xFF) << 8)  |  (p[47] & 0xFF);
        int balRaw  = (short)(((p[40] & 0xFF) << 8) | (p[41] & 0xFF));
        int mixOpt  = p[49] & 0xFF;
        double gain    = faderGainRaw / 100.0;  // centidB → dB
        double balance = balRaw / 200.0;        // same scale as classic audio
        Log.d(TAG, "FASP ch=" + ch + " faderGain=" + gain + " bal=" + balance + " mix=" + mixOpt);
        audioChannels.put(ch, new double[]{gain, balance, mixOpt});
    }

    private void parseFairlightMaster(byte[] p) {
        // FAMP — Fairlight Audio Master Update
        // Ref: atem-connection v3 FairlightMixerMasterUpdateCommand
        // 0:     bandCount
        // 1:     equalizerEnabled
        // 4-7:   equalizerGain (int32 BE)
        // 8-11:  makeUpGain (int32 BE)
        // 12-15: faderGain (int32 BE, centidB) — master fader
        // 16:    followFadeToBlack
        if (p.length < 17) {
            Log.d(TAG, "FAMP short payload len=" + p.length);
            return;
        }
        int gainRaw32 = ((p[12] & 0xFF) << 24) | ((p[13] & 0xFF) << 16)
                      | ((p[14] & 0xFF) << 8)  |  (p[15] & 0xFF);
        masterGain    = gainRaw32 / 100.0;
        masterBalance = 0.0; // Fairlight master has no balance/pan
        Log.d(TAG, "FAMP faderGain=" + masterGain);
    }

    private void parseFairlightInputProps(byte[] p) {
        // FAIP — Fairlight Audio Input Properties (registers channel presence)
        // 0-1: audioSource (uint16) — same IDs as AMIP
        if (p.length < 2) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        Log.d(TAG, "FAIP ch=" + ch + " len=" + p.length);
        // Ensure channel exists so it appears in the mixer
        if (!audioChannels.containsKey(ch)) {
            audioChannels.put(ch, new double[]{0.0, 0.0, 1.0}); // gain=0dB, center, ON
        }
    }

    private void parseFairlightLevels(byte[] p) {
        // FMLv — Fairlight Source Levels (one packet per source)
        // Ref: atem-connection v3 FairlightMixerSourceLevelsUpdateCommand
        // 0-7:   source (BigInt64 BE) — skip
        // 8-9:   index (uint16 BE)   — channel ID
        // 32-33: leftLevel  (int16)  — output left
        // 34-35: rightLevel (int16)  — output right
        // 36-37: leftPeak   (int16)
        // 38-39: rightPeak  (int16)
        if (p.length < 40) return;
        int ch = ((p[8] & 0xFF) << 8) | (p[9] & 0xFF);
        double left      = (short)(((p[32] & 0xFF) << 8) | (p[33] & 0xFF)) / 100.0;
        double right     = (short)(((p[34] & 0xFF) << 8) | (p[35] & 0xFF)) / 100.0;
        double peakLeft  = (short)(((p[36] & 0xFF) << 8) | (p[37] & 0xFF)) / 100.0;
        double peakRight = (short)(((p[38] & 0xFF) << 8) | (p[39] & 0xFF)) / 100.0;
        vuLevels.put(ch, new double[]{left, right, peakLeft, peakRight});
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
        // DSK state comes from DskS packets handled above
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
                d.put("fillSource", 0);
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

    // ── Send helpers ──────────────────────────────────────────────

    private void sendHello() throws Exception {
        // 20-byte hello packet
        byte[] pkt = new byte[20];
        pkt[0] = 0x10; pkt[1] = 0x14; // flags=HELLO, len=20
        pkt[2] = 0x53; pkt[3] = (byte)0xAB; // placeholder session
        // bytes 4-11 = 0
        pkt[12] = 0x01; // version?
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

    public void sendAudioInputGain(int ch, double gain) {
        // CAIP: mask(2) + channel(2) + mixOption(1) + pad(1) + gain(2) + balance(2)
        // mask bit 0 = gain changed, bit 1 = balance, bit 2 = mixOption
        int gainRaw = (int)Math.round(gain * 256);
        byte[] p = new byte[12];
        p[0] = 0x00; p[1] = 0x01; // mask: gain only
        p[2] = (byte)((ch >> 8) & 0xFF); p[3] = (byte)(ch & 0xFF);
        p[8] = (byte)((gainRaw >> 8) & 0xFF); p[9] = (byte)(gainRaw & 0xFF);
        sendCommand(makeCmd("CAIP", p));
    }

    public void sendAudioInputMixOption(int ch, int mixOption) {
        int gainRaw = 0;
        double[] cur = audioChannels.get(ch);
        if (cur != null) gainRaw = (int)Math.round(cur[0] * 256);
        byte[] p = new byte[12];
        p[0] = 0x00; p[1] = 0x04; // mask: mixOption
        p[2] = (byte)((ch >> 8) & 0xFF); p[3] = (byte)(ch & 0xFF);
        p[4] = (byte)(mixOption & 0xFF);
        p[8] = (byte)((gainRaw >> 8) & 0xFF); p[9] = (byte)(gainRaw & 0xFF);
        sendCommand(makeCmd("CAIP", p));
    }

    public void sendAudioInputBalance(int ch, double balance) {
        int balRaw = (int)Math.round(balance * 10000);
        double[] cur = audioChannels.get(ch);
        int gainRaw = cur != null ? (int)Math.round(cur[0] * 256) : 0;
        byte[] p = new byte[12];
        p[0] = 0x00; p[1] = 0x02; // mask: balance
        p[2] = (byte)((ch >> 8) & 0xFF); p[3] = (byte)(ch & 0xFF);
        p[8] = (byte)((gainRaw >> 8) & 0xFF); p[9] = (byte)(gainRaw & 0xFF);
        p[10] = (byte)((balRaw >> 8) & 0xFF); p[11] = (byte)(balRaw & 0xFF);
        sendCommand(makeCmd("CAIP", p));
    }

    public void sendMasterGain(double gain) {
        // CAMP: mask(2) + gain(2) + balance(2)
        int gainRaw = (int)Math.round(gain * 256);
        byte[] p = new byte[6];
        p[0] = 0x00; p[1] = 0x01; // mask: gain
        p[2] = (byte)((gainRaw >> 8) & 0xFF); p[3] = (byte)(gainRaw & 0xFF);
        sendCommand(makeCmd("CAMP", p));
    }

    public void sendMasterBalance(double balance) {
        int balRaw = (int)Math.round(balance * 10000);
        int gainRaw = (int)Math.round(masterGain * 256);
        byte[] p = new byte[6];
        p[0] = 0x00; p[1] = 0x02; // mask: balance
        p[2] = (byte)((gainRaw >> 8) & 0xFF); p[3] = (byte)(gainRaw & 0xFF);
        p[4] = (byte)((balRaw >> 8) & 0xFF); p[5] = (byte)(balRaw & 0xFF);
        sendCommand(makeCmd("CAMP", p));
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
        sendCommand(makeCmd("CDsA", p));
    }

    public void sendAutoDSK(int keyerIndex) {
        // CDsT: keyerIndex(1) + pad(3)
        byte[] p = new byte[4];
        p[0] = (byte)(keyerIndex & 0xFF);
        sendCommand(makeCmd("CDsT", p));
    }

    public void sendMediaPlayerSource(int playerIndex, int stillIndex) {
        // MESP: playerIndex(1) + sourceType(1) + stillIndex(1) + pad(1)
        byte[] p = new byte[4];
        p[0] = (byte)(playerIndex & 0xFF);
        p[1] = 0x01; // sourceType = still
        p[2] = (byte)(stillIndex & 0xFF);
        sendCommand(makeCmd("MESP", p));
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
                receiveThread = new Thread(this::receiveLoop, "atem-recv");
                receiveThread.setDaemon(true);
                receiveThread.start();
            }
        }, RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS);
    }
}
