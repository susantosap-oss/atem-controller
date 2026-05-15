package com.atempwa.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

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

/**
 * M32Connection — Midas M32R OSC UDP client.
 * Port 10023, OSC 1.0 big-endian protocol.
 * Auto-reconnects every 5s if M32 stops responding (socket timeout or error).
 *
 * Protocol:
 *   /xremote               → subscribe param-change push (renew every 9s)
 *   /ch/NN/config/name     → channel name query
 *   /bus/NN/config/name    → bus name query
 *   /bus/NN/config/ms      → bus mono/stereo config
 *   /ch/NN/mix/MM/level    → channel NN send level to bus MM (float 0-1)
 *   /ch/NN/mix/MM/on       → channel NN send on/off to bus MM (int 0/1)
 *   /ch/NN/mix/MM/pre      → channel NN send pre/post-fader (int 0=post, 1=pre)
 *   /bus/NN/mix/level      → bus NN master fader
 *   /bus/NN/mix/on         → bus NN master on/off
 *   /meters <str>          → request meter blob (/meters/1=input, /meters/5=bus)
 */
public class M32Connection {

    private static final String TAG                  = "M32Connection";
    private static final int    M32_PORT             = 10023;
    private static final int    RECV_BUFFER          = 8192;
    private static final long   XREMOTE_INTERVAL_MS  = 9_000;
    private static final long   METER_INTERVAL_MS    = 80;
    private static final long   RECONNECT_DELAY_MS   = 5_000;
    private static final int    SOCKET_TIMEOUT_MS    = 5_000;

    public interface Listener {
        void onStatus(String status, String ip, String error);
        void onChannelNames(JSObject names);
        void onBusNames(JSObject names);
        void onBusConfig(JSObject config);
        void onSendLevel(String ch, String bus, double level, boolean on);
        void onSendOn(String ch, String bus, double level, boolean on);
        void onSendPre(String ch, String bus, boolean pre);
        void onBusLevel(String bus, double level, boolean on);
        void onBusOn(String bus, double level, boolean on);
        void onInputMeters(JSObject meters);
        void onBusMeters(JSObject meters);
    }

    private final String   ip;
    private final Listener listener;
    private final Handler  mainHandler = new Handler(Looper.getMainLooper());

    private volatile DatagramSocket  socket;
    private volatile boolean         running = false;
    private boolean                  firstMessage;
    private ScheduledExecutorService scheduler;
    private ScheduledFuture<?>       xremoteFuture;
    private ScheduledFuture<?>       meterFuture;
    private Thread                   recvThread;

    // Cached state
    private final Map<String, String>   channelNames = new HashMap<>();
    private final Map<String, String>   busNames     = new HashMap<>();
    private final Map<String, Boolean>  busMono      = new HashMap<>();
    private final Map<String, double[]> sendLevels   = new HashMap<>(); // "ch:bus" → [level, on]
    private final Map<String, Boolean>  sendPre      = new HashMap<>(); // "ch:bus" → pre
    private final Map<String, double[]> busLevels    = new HashMap<>(); // bus      → [level, on]

    public M32Connection(String ip, Listener listener) {
        this.ip       = ip;
        this.listener = listener;
    }

    // ── Lifecycle ─────────────────────────────────────────────

    public void connect() {
        if (running) disconnect();
        running      = true;
        firstMessage = true;
        emitStatus("connecting", null);

        scheduler  = Executors.newSingleThreadScheduledExecutor();
        recvThread = new Thread(this::receiveLoop, "M32-recv");
        recvThread.setDaemon(true);
        recvThread.start();
    }

    public void disconnect() {
        running = false;
        Thread t = recvThread;
        if (t != null) { t.interrupt(); recvThread = null; }
        cancelTimers();
        if (scheduler != null) { scheduler.shutdownNow(); scheduler = null; }
        DatagramSocket s = socket;
        if (s != null) { try { s.close(); } catch (Exception ignored) {} socket = null; }
        emitStatus("disconnected", null);
        Log.i(TAG, "M32 disconnected");
    }

    public boolean isConnected() {
        DatagramSocket s = socket;
        return running && s != null && !s.isClosed();
    }

    // ── Receive loop with auto-reconnect ─────────────────────

    private void receiveLoop() {
        while (running) {
            cancelTimers();
            DatagramSocket sock = null;

            try {
                sock   = new DatagramSocket(0);
                sock.setSoTimeout(SOCKET_TIMEOUT_MS);
                socket = sock;
                Log.i(TAG, "M32 bound → " + ip + ":" + M32_PORT);

                xremoteFuture = scheduler.scheduleAtFixedRate(
                    this::sendXremote, 0, XREMOTE_INTERVAL_MS, TimeUnit.MILLISECONDS);
                meterFuture = scheduler.scheduleAtFixedRate(
                    this::pollMeters, 500, METER_INTERVAL_MS, TimeUnit.MILLISECONDS);

                queryAllNames();
                firstMessage = true;

                byte[]        buf = new byte[RECV_BUFFER];
                DatagramPacket pkt = new DatagramPacket(buf, buf.length);

                while (running) {
                    try {
                        sock.receive(pkt);
                        handlePacket(buf, pkt.getLength());
                    } catch (java.net.SocketTimeoutException te) {
                        if (running) {
                            Log.w(TAG, "M32 no response for " + SOCKET_TIMEOUT_MS + "ms – reconnecting");
                            emitStatus("connecting", null);
                        }
                        break; // exit inner loop → retry
                    }
                }

            } catch (Exception e) {
                if (running) {
                    Log.e(TAG, "M32 error: " + e.getMessage());
                    emitStatus("error", e.getMessage());
                }
            } finally {
                cancelTimers();
                DatagramSocket s = sock;
                if (s != null && !s.isClosed()) { try { s.close(); } catch (Exception ignored) {} }
                socket = null;
            }

            if (running) {
                try {
                    Thread.sleep(RECONNECT_DELAY_MS);
                    if (running) emitStatus("connecting", null);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    private void cancelTimers() {
        if (xremoteFuture != null) { xremoteFuture.cancel(false); xremoteFuture = null; }
        if (meterFuture   != null) { meterFuture.cancel(false);   meterFuture   = null; }
    }

    // ── OSC Send helpers ──────────────────────────────────────

    private void sendRaw(byte[] data) {
        DatagramSocket s = socket;
        if (s == null || s.isClosed() || !running) return;
        try {
            InetAddress addr = InetAddress.getByName(ip);
            s.send(new DatagramPacket(data, data.length, addr, M32_PORT));
        } catch (Exception e) {
            Log.w(TAG, "send error: " + e.getMessage());
        }
    }

    private void sendNoArgs(String address)            { sendRaw(oscEncodeNoArgs(address)); }
    private void sendFloat(String address, float value) { sendRaw(oscEncodeFloat(address, value)); }
    private void sendInt(String address, int value)     { sendRaw(oscEncodeInt(address, value)); }
    private void sendString(String address, String val) { sendRaw(oscEncodeString(address, val)); }

    private void sendXremote() { sendNoArgs("/xremote"); }
    private void pollMeters() {
        sendString("/meters", "/meters/1");
        sendString("/meters", "/meters/5");
    }

    // ── OSC Encode ────────────────────────────────────────────

    private static int padLen(int n) {
        int r = n % 4;
        return r == 0 ? n : n + (4 - r);
    }

    private static byte[] encStr(String s) {
        byte[] src = (s + "\0").getBytes();
        int    len = padLen(src.length);
        byte[] buf = new byte[len];
        System.arraycopy(src, 0, buf, 0, src.length);
        return buf;
    }

    private static byte[] oscEncodeNoArgs(String address) {
        byte[] addrB = encStr(address);
        byte[] tagB  = encStr(",");
        byte[] out   = new byte[addrB.length + tagB.length];
        System.arraycopy(addrB, 0, out, 0,             addrB.length);
        System.arraycopy(tagB,  0, out, addrB.length,  tagB.length);
        return out;
    }

    private static byte[] oscEncodeFloat(String address, float value) {
        byte[] addrB = encStr(address);
        byte[] tagB  = encStr(",f");
        byte[] argB  = new byte[4];
        ByteBuffer.wrap(argB).order(ByteOrder.BIG_ENDIAN).putFloat(value);
        byte[] out = new byte[addrB.length + tagB.length + 4];
        int p = 0;
        System.arraycopy(addrB, 0, out, p, addrB.length); p += addrB.length;
        System.arraycopy(tagB,  0, out, p, tagB.length);  p += tagB.length;
        System.arraycopy(argB,  0, out, p, 4);
        return out;
    }

    private static byte[] oscEncodeInt(String address, int value) {
        byte[] addrB = encStr(address);
        byte[] tagB  = encStr(",i");
        byte[] argB  = new byte[4];
        ByteBuffer.wrap(argB).order(ByteOrder.BIG_ENDIAN).putInt(value);
        byte[] out = new byte[addrB.length + tagB.length + 4];
        int p = 0;
        System.arraycopy(addrB, 0, out, p, addrB.length); p += addrB.length;
        System.arraycopy(tagB,  0, out, p, tagB.length);  p += tagB.length;
        System.arraycopy(argB,  0, out, p, 4);
        return out;
    }

    private static byte[] oscEncodeString(String address, String value) {
        byte[] addrB = encStr(address);
        byte[] tagB  = encStr(",s");
        byte[] valB  = encStr(value);
        byte[] out   = new byte[addrB.length + tagB.length + valB.length];
        int p = 0;
        System.arraycopy(addrB, 0, out, p, addrB.length); p += addrB.length;
        System.arraycopy(tagB,  0, out, p, tagB.length);  p += tagB.length;
        System.arraycopy(valB,  0, out, p, valB.length);
        return out;
    }

    // ── OSC Decode ────────────────────────────────────────────

    private static class OscMessage {
        String   address;
        Object[] args;
        OscMessage(String a, Object[] g) { address = a; args = g; }
    }

    private static OscMessage oscDecode(byte[] data, int len) {
        try {
            int end = 0;
            while (end < len && data[end] != 0) end++;
            String address = new String(data, 0, end);
            if (!address.startsWith("/")) return null;
            int off = padLen(end + 1);
            if (off >= len) return new OscMessage(address, new Object[0]);

            end = off;
            while (end < len && data[end] != 0) end++;
            String tagStr = new String(data, off, end - off);
            off = padLen(end + 1);
            String types  = tagStr.startsWith(",") ? tagStr.substring(1) : tagStr;

            Object[] args = new Object[types.length()];
            for (int i = 0; i < types.length(); i++) {
                if (off >= len) break;
                char t = types.charAt(i);
                if (t == 'f') {
                    args[i] = ByteBuffer.wrap(data, off, 4).order(ByteOrder.BIG_ENDIAN).getFloat();
                    off += 4;
                } else if (t == 'i') {
                    args[i] = ByteBuffer.wrap(data, off, 4).order(ByteOrder.BIG_ENDIAN).getInt();
                    off += 4;
                } else if (t == 's') {
                    end = off;
                    while (end < len && data[end] != 0) end++;
                    args[i] = new String(data, off, end - off);
                    off += padLen(end - off + 1);
                } else if (t == 'b') {
                    int blen = ByteBuffer.wrap(data, off, 4).order(ByteOrder.BIG_ENDIAN).getInt();
                    off += 4;
                    byte[] blob = new byte[blen];
                    System.arraycopy(data, off, blob, 0, Math.min(blen, len - off));
                    args[i] = blob;
                    off += padLen(blen);
                }
            }
            return new OscMessage(address, args);
        } catch (Exception e) {
            Log.w(TAG, "oscDecode: " + e.getMessage());
            return null;
        }
    }

    // ── Incoming message handler ──────────────────────────────

    private void handlePacket(byte[] data, int len) {
        OscMessage msg = oscDecode(data, len);
        if (msg == null) return;

        if (firstMessage) {
            firstMessage = false;
            emitStatus("connected", null);
        }

        String addr = msg.address;
        Object a0   = msg.args.length > 0 ? msg.args[0] : null;

        // /ch/NN/config/name
        if (addr.matches("^/ch/\\d+/config/name$")) {
            String[] p    = addr.split("/");
            String   ch   = p[2];
            String   name = a0 instanceof String ? ((String) a0).trim() : "";
            if (name.isEmpty()) name = "CH " + Integer.parseInt(ch);
            channelNames.put(ch, name);
            emitChannelNames();
            return;
        }

        // /bus/NN/config/name
        if (addr.matches("^/bus/\\d+/config/name$")) {
            String[] p    = addr.split("/");
            String   bus  = p[2];
            String   name = a0 instanceof String ? ((String) a0).trim() : "";
            if (name.isEmpty()) name = "Bus " + Integer.parseInt(bus);
            busNames.put(bus, name);
            emitBusNames();
            return;
        }

        // /bus/NN/config/ms
        if (addr.matches("^/bus/\\d+/config/ms$")) {
            String[] p    = addr.split("/");
            String   bus  = p[2];
            boolean  mono = (a0 instanceof Integer) && ((Integer) a0) == 1;
            busMono.put(bus, mono);
            emitBusConfig();
            return;
        }

        // /ch/NN/mix/MM/level
        if (addr.matches("^/ch/\\d+/mix/\\d+/level$")) {
            String[] p     = addr.split("/");
            String   ch    = p[2], bus = p[4];
            float    level = a0 instanceof Float ? (Float) a0 : 0.75f;
            String   key   = ch + ":" + bus;
            if (!sendLevels.containsKey(key)) sendLevels.put(key, new double[]{0.75, 1});
            sendLevels.get(key)[0] = level;
            mainHandler.post(() -> listener.onSendLevel(ch, bus, level, sendLevels.get(key)[1] != 0));
            return;
        }

        // /ch/NN/mix/MM/on
        if (addr.matches("^/ch/\\d+/mix/\\d+/on$")) {
            String[] p   = addr.split("/");
            String   ch  = p[2], bus = p[4];
            boolean  on  = (a0 instanceof Integer) && ((Integer) a0) == 1;
            String   key = ch + ":" + bus;
            if (!sendLevels.containsKey(key)) sendLevels.put(key, new double[]{0.75, 1});
            sendLevels.get(key)[1] = on ? 1 : 0;
            mainHandler.post(() -> listener.onSendOn(ch, bus, sendLevels.get(key)[0], on));
            return;
        }

        // /ch/NN/mix/MM/pre  — 0=post-fader, 1=pre-fader
        if (addr.matches("^/ch/\\d+/mix/\\d+/pre$")) {
            String[] p   = addr.split("/");
            String   ch  = p[2], bus = p[4];
            boolean  pre = (a0 instanceof Integer) && ((Integer) a0) == 1;
            sendPre.put(ch + ":" + bus, pre);
            mainHandler.post(() -> listener.onSendPre(ch, bus, pre));
            return;
        }

        // /bus/NN/mix/level
        if (addr.matches("^/bus/\\d+/mix/level$")) {
            String[] p     = addr.split("/");
            String   bus   = p[2];
            float    level = a0 instanceof Float ? (Float) a0 : 0.75f;
            if (!busLevels.containsKey(bus)) busLevels.put(bus, new double[]{0.75, 1});
            busLevels.get(bus)[0] = level;
            mainHandler.post(() -> listener.onBusLevel(bus, level, busLevels.get(bus)[1] != 0));
            return;
        }

        // /bus/NN/mix/on
        if (addr.matches("^/bus/\\d+/mix/on$")) {
            String[] p   = addr.split("/");
            String   bus = p[2];
            boolean  on  = (a0 instanceof Integer) && ((Integer) a0) == 1;
            if (!busLevels.containsKey(bus)) busLevels.put(bus, new double[]{0.75, 1});
            busLevels.get(bus)[1] = on ? 1 : 0;
            mainHandler.post(() -> listener.onBusOn(bus, busLevels.get(bus)[0], on));
            return;
        }

        // /meters/1  — 32 input channels
        if (addr.equals("/meters/1") && a0 instanceof byte[]) {
            JSObject m = parseMeterBlob((byte[]) a0, 32);
            if (m != null) mainHandler.post(() -> listener.onInputMeters(m));
            return;
        }

        // /meters/5  — 16 bus channels
        if (addr.equals("/meters/5") && a0 instanceof byte[]) {
            JSObject m = parseMeterBlob((byte[]) a0, 16);
            if (m != null) mainHandler.post(() -> listener.onBusMeters(m));
        }
    }

    // ── Meter blob parser ─────────────────────────────────────
    // Blob: 4-byte LE int32 count + count × LE float32, stereo L/R pairs

    private static JSObject parseMeterBlob(byte[] blob, int numCh) {
        if (blob == null || blob.length < 8) return null;
        try {
            int countLE  = ByteBuffer.wrap(blob, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            int expected = countLE * 4;
            int offset   = (expected > 0 && expected <= blob.length - 4) ? 4 : 0;

            JSObject result = new JSObject();
            for (int i = 0; i < numCh; i++) {
                int lo = offset + i * 8;
                int ro = lo + 4;
                if (ro + 4 > blob.length) break;
                float    lv  = ByteBuffer.wrap(blob, lo, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
                float    rv  = ByteBuffer.wrap(blob, ro, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
                String   key = String.format("%02d", i + 1);
                JSObject ch  = new JSObject();
                ch.put("left",  linToDbFS(lv));
                ch.put("right", linToDbFS(rv));
                result.put(key, ch);
            }
            return result;
        } catch (Exception e) {
            Log.w(TAG, "parseMeterBlob: " + e.getMessage());
            return null;
        }
    }

    private static double linToDbFS(float v) {
        if (v <= 0) return -90;
        return Math.max(-90, Math.round(20 * Math.log10(v) * 10.0) / 10.0);
    }

    // ── Initial queries ───────────────────────────────────────

    private void queryAllNames() {
        for (int i = 1; i <= 32; i++) {
            String ch = String.format("%02d", i);
            sendNoArgs("/ch/" + ch + "/config/name");
        }
        for (int i = 1; i <= 16; i++) {
            String b = String.format("%02d", i);
            sendNoArgs("/bus/" + b + "/config/name");
            sendNoArgs("/bus/" + b + "/config/ms");
            sendNoArgs("/bus/" + b + "/mix/level");
            sendNoArgs("/bus/" + b + "/mix/on");
        }
    }

    public void queryBus(int busNum) {
        String bus = String.format("%02d", busNum);
        sendNoArgs("/bus/" + bus + "/mix/level");
        sendNoArgs("/bus/" + bus + "/mix/on");
        for (int i = 1; i <= 32; i++) {
            String ch = String.format("%02d", i);
            sendNoArgs("/ch/" + ch + "/mix/" + bus + "/level");
            sendNoArgs("/ch/" + ch + "/mix/" + bus + "/on");
            sendNoArgs("/ch/" + ch + "/mix/" + bus + "/pre");
        }
    }

    // ── Control API ───────────────────────────────────────────

    public void setChannelSendLevel(String ch, String bus, float level) {
        float  clamped = Math.min(1f, Math.max(0f, level));
        sendFloat("/ch/" + ch + "/mix/" + bus + "/level", clamped);
        String key = ch + ":" + bus;
        if (!sendLevels.containsKey(key)) sendLevels.put(key, new double[]{0.75, 1});
        sendLevels.get(key)[0] = clamped;
        mainHandler.post(() -> listener.onSendLevel(ch, bus, clamped, sendLevels.get(key)[1] != 0));
    }

    public void setChannelSendOn(String ch, String bus, boolean on) {
        sendInt("/ch/" + ch + "/mix/" + bus + "/on", on ? 1 : 0);
        String key = ch + ":" + bus;
        if (!sendLevels.containsKey(key)) sendLevels.put(key, new double[]{0.75, 1});
        sendLevels.get(key)[1] = on ? 1 : 0;
        mainHandler.post(() -> listener.onSendOn(ch, bus, sendLevels.get(key)[0], on));
    }

    public void setBusLevel(String bus, float level) {
        float clamped = Math.min(1f, Math.max(0f, level));
        sendFloat("/bus/" + bus + "/mix/level", clamped);
        if (!busLevels.containsKey(bus)) busLevels.put(bus, new double[]{0.75, 1});
        busLevels.get(bus)[0] = clamped;
        mainHandler.post(() -> listener.onBusLevel(bus, clamped, busLevels.get(bus)[1] != 0));
    }

    public void setBusOn(String bus, boolean on) {
        sendInt("/bus/" + bus + "/mix/on", on ? 1 : 0);
        if (!busLevels.containsKey(bus)) busLevels.put(bus, new double[]{0.75, 1});
        busLevels.get(bus)[1] = on ? 1 : 0;
        mainHandler.post(() -> listener.onBusOn(bus, busLevels.get(bus)[0], on));
    }

    // ── State emitters ────────────────────────────────────────

    private void emitStatus(String status, String error) {
        mainHandler.post(() -> listener.onStatus(status, ip, error));
    }

    private void emitChannelNames() {
        JSObject obj = new JSObject();
        for (Map.Entry<String, String> e : channelNames.entrySet()) obj.put(e.getKey(), e.getValue());
        mainHandler.post(() -> listener.onChannelNames(obj));
    }

    private void emitBusNames() {
        JSObject obj = new JSObject();
        for (Map.Entry<String, String> e : busNames.entrySet()) obj.put(e.getKey(), e.getValue());
        mainHandler.post(() -> listener.onBusNames(obj));
    }

    private void emitBusConfig() {
        JSObject obj = new JSObject();
        for (Map.Entry<String, Boolean> e : busMono.entrySet()) {
            JSObject cfg = new JSObject();
            cfg.put("mono", e.getValue());
            obj.put(e.getKey(), cfg);
        }
        mainHandler.post(() -> listener.onBusConfig(obj));
    }
}
