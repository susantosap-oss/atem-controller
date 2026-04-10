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
    }

    public void disconnect() {
        running = false;
        connected = false;
        initialized = false;
        if (connectTimeoutFuture != null) { connectTimeoutFuture.cancel(true); }
        if (reconnectFuture != null) { reconnectFuture.cancel(true); }
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
                    // Normal timeout, keep looping
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

        boolean isHello = (flags & 0x08) != 0;  // SYN/init
        boolean isAck   = (flags & 0x10) != 0;  // ACK only packet

        if (isHello && sessionId == 0) {
            // ATEM responded to our hello — extract session ID
            sessionId = pktSession;
            Log.d(TAG, "Session established: 0x" + Integer.toHexString(sessionId));
            sendAck(0);
            return;
        }

        if (sessionId == 0) return;

        // ACK-only packet — ignore
        if (isAck) return;

        // Parse command blocks from payload
        if (pktLen > 12 && len >= pktLen) {
            parseCommands(data, pktLen);
        }

        // Send ACK for this packet
        if (remoteId != 0) {
            lastRemotePacketId = remoteId;
            sendAck(remoteId);
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
        }
    }

    private void parseCommands(byte[] data, int totalLen) {
        int pos = 12; // skip 12-byte header
        boolean audioChanged = false;
        boolean videoChanged = false;
        boolean vuChanged = false;

        while (pos + 8 <= totalLen) {
            int cmdLen = ((data[pos] & 0xFF) << 8) | (data[pos + 1] & 0xFF);
            if (cmdLen < 8 || pos + cmdLen > totalLen) break;

            String cmd = new String(data, pos + 4, 4);
            byte[] payload = new byte[cmdLen - 8];
            System.arraycopy(data, pos + 8, payload, 0, payload.length);

            switch (cmd) {
                case "AMIP": parseAudioInputProps(payload);   audioChanged = true; break;
                case "AMmO": parseAudioMasterOutput(payload); audioChanged = true; break;
                case "AMLv": parseAudioLevels(payload);       vuChanged = true;    break;
                case "PrvI": parsePreviewInput(payload);      videoChanged = true; break;
                case "PrgI": parseProgramInput(payload);      videoChanged = true; break;
                case "TrSS": parseTransitionState(payload);   videoChanged = true; break;
                case "DskS": parseDSKState(payload, 0);       videoChanged = true; break;
                case "DskP": parseDSKProps(payload);                               break;
                case "InPr": parseInputProps(payload);                              break;
            }

            pos += cmdLen;
        }

        if (initialized) {
            if (audioChanged) emitFullAudioState();
            if (videoChanged) emitFullVideoState();
            if (vuChanged)    emitVuMeter();
        }
    }

    // ── State parsers ─────────────────────────────────────────────

    private void parseAudioInputProps(byte[] p) {
        if (p.length < 12) return;
        int ch = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        int mixOpt = p[2] & 0xFF;
        // gain: signed 16-bit at offset 8, value in units of 256 = 1dB
        int gainRaw = (short)(((p[8] & 0xFF) << 8) | (p[9] & 0xFF));
        // balance: signed 16-bit at offset 10, range -10000..10000
        int balRaw  = (short)(((p[10] & 0xFF) << 8) | (p[11] & 0xFF));

        double gain    = gainRaw / 256.0;
        double balance = balRaw / 10000.0;
        audioChannels.put(ch, new double[]{gain, balance, mixOpt});
    }

    private void parseAudioMasterOutput(byte[] p) {
        if (p.length < 6) return;
        int gainRaw = (short)(((p[0] & 0xFF) << 8) | (p[1] & 0xFF));
        int balRaw  = (short)(((p[2] & 0xFF) << 8) | (p[3] & 0xFF));
        masterGain    = gainRaw / 256.0;
        masterBalance = balRaw / 10000.0;
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

    private void parseTransitionState(byte[] p) {
        if (p.length < 6) return;
        transitionStyle      = p[1] & 0xFF;
        transitionInProgress = (p[0] & 0x04) != 0;
        transitionPosition   = ((p[4] & 0xFF) << 8) | (p[5] & 0xFF);
        ftbFullyBlack        = (p[0] & 0x02) != 0;
        ftbInTransition      = (p[0] & 0x01) != 0;
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

    private void parseInputProps(byte[] p) {
        if (p.length < 4) return;
        int src = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        // Short name at offset 2, 4 chars
        if (p.length >= 6) {
            String name = new String(p, 2, 4).trim().replace("\0", "");
            if (!name.isEmpty()) inputLabels.put(src, name);
        }
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
        if (socket == null || socket.isClosed() || !connected) return;
        try {
            int pid = localPacketId.incrementAndGet() & 0x7FFF;
            int totalLen = 12 + cmdData.length;
            byte[] pkt = new byte[totalLen];
            int sid = sessionId;
            // flags=0x08 (data + request ack), length
            pkt[0] = (byte)(0x08 | ((totalLen >> 8) & 0x07));
            pkt[1] = (byte)(totalLen & 0xFF);
            pkt[2] = (byte)((sid >> 8) & 0xFF); pkt[3] = (byte)(sid & 0xFF);
            pkt[4] = (byte)((lastRemotePacketId >> 8) & 0xFF); pkt[5] = (byte)(lastRemotePacketId & 0xFF);
            pkt[6] = (byte)((pid >> 8) & 0xFF); pkt[7] = (byte)(pid & 0xFF);
            System.arraycopy(cmdData, 0, pkt, 12, cmdData.length);
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
