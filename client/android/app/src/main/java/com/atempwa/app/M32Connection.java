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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
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
        void onAuxInNames(JSObject names);
        void onFxRtnNames(JSObject names);
        void onChannelOn(String ch, boolean on);
        void onAuxInOn(String ch, boolean on);
        void onFxRtnOn(String ch, boolean on);
        void onDcaNames(JSObject names);
        void onDcaOn(String dca, boolean on);
        void onSendLevel(String ch, String bus, double level, boolean on);
        void onSendOn(String ch, String bus, double level, boolean on);
        void onSendPre(String ch, String bus, boolean pre);
        void onAuxInSendLevel(String ch, String bus, double level, boolean on);
        void onAuxInSendOn(String ch, String bus, double level, boolean on);
        void onFxRtnSendLevel(String ch, String bus, double level, boolean on);
        void onFxRtnSendOn(String ch, String bus, double level, boolean on);
        void onBusLevel(String bus, double level, boolean on);
        void onBusOn(String bus, double level, boolean on);
        void onInputMeters(JSObject meters);
        void onAuxInMeters(JSObject meters);
        void onFxRtnMeters(JSObject meters);
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
    private final List<ScheduledFuture<?>> queryFutures = new ArrayList<>();
    private Thread                   recvThread;

    // Cached state
    private final Map<String, String>   channelNames = new HashMap<>();
    private final Map<String, String>   busNames     = new HashMap<>();
    private final Map<String, Boolean>  busMono      = new HashMap<>();
    private final Map<String, String>   auxInNames   = new HashMap<>();
    private final Map<String, String>   fxRtnNames   = new HashMap<>();
    private final Map<String, Boolean>  channelOn    = new HashMap<>(); // effective mute (own AND DCA)
    private final Map<String, Boolean>  channelOwnOn = new HashMap<>(); // channel own mute only (/ch/NN/mix/on)
    private final Map<String, Integer>  chDcaMask    = new HashMap<>(); // ch → DCA bitmask (/ch/NN/grp/dca)
    private final Map<String, Boolean>  auxInOn          = new HashMap<>();
    private final Map<String, Boolean>  fxRtnOn          = new HashMap<>();
    private final Map<String, double[]> auxInSendLevels  = new HashMap<>(); // "ch:bus" → [level, on]
    private final Map<String, double[]> fxRtnSendLevels  = new HashMap<>();
    private final Map<String, String>   dcaNames     = new HashMap<>();
    private final Map<String, Boolean>  dcaOn        = new HashMap<>(); // "01".."08" → true=active, false=muted
    private final Map<String, double[]> sendLevels   = new HashMap<>(); // "ch:bus" → [level, on]
    private final Map<String, Boolean>  sendPre      = new HashMap<>();
    private final Map<String, double[]> busLevels    = new HashMap<>();

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

                // Send /xremote synchronously first — M32 only responds to queries
                // from hosts that have recently sent /xremote. Must arrive before queries.
                sendXremote();
                xremoteFuture = scheduler.scheduleAtFixedRate(
                    this::sendXremote, XREMOTE_INTERVAL_MS, XREMOTE_INTERVAL_MS, TimeUnit.MILLISECONDS);
                meterFuture = scheduler.scheduleAtFixedRate(
                    this::pollMeters, 500, METER_INTERVAL_MS, TimeUnit.MILLISECONDS);

                // Clear per-channel own-mute cache so stale state from prior session
                // doesn't cause emitEffectiveChannelOn to emit wrong values before the
                // new session's /ch/NN/mix/on responses arrive.
                channelOwnOn.clear();
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
        for (ScheduledFuture<?> f : queryFutures) f.cancel(false);
        queryFutures.clear();
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
        sendString("/meters", "/meters/2");
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
                    off = padLen(end + 1);
                } else if (t == 'b') {
                    int blen = ByteBuffer.wrap(data, off, 4).order(ByteOrder.BIG_ENDIAN).getInt();
                    off += 4;
                    byte[] blob = new byte[blen];
                    System.arraycopy(data, off, blob, 0, Math.min(blen, len - off));
                    args[i] = blob;
                    off += padLen(blen);
                } else if (t == 'T') {
                    args[i] = Integer.valueOf(1); // OSC True — no data bytes
                } else if (t == 'F') {
                    args[i] = Integer.valueOf(0); // OSC False — no data bytes
                }
                // 'N' (nil), 'I' (impulse) — no data bytes, leave args[i] = null
            }
            return new OscMessage(address, args);
        } catch (Exception e) {
            Log.w(TAG, "oscDecode: " + e.getMessage());
            return null;
        }
    }

    // ── Incoming message handler ──────────────────────────────

    private void handlePacket(byte[] data, int len) {
        // OSC bundle: "#bundle\0" + 8-byte timetag + length-prefixed messages
        if (len >= 16 && data[0] == '#') {
            int off = 16; // skip #bundle\0 (8 bytes) + timetag (8 bytes)
            while (off + 4 <= len) {
                int msgLen = ByteBuffer.wrap(data, off, 4).order(ByteOrder.BIG_ENDIAN).getInt();
                off += 4;
                if (msgLen <= 0 || off + msgLen > len) break;
                byte[] sub = new byte[msgLen];
                System.arraycopy(data, off, sub, 0, msgLen);
                handlePacket(sub, msgLen); // recurse (handles nested bundles too)
                off += msgLen;
            }
            return;
        }

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
            String   ch   = String.format("%02d", Integer.parseInt(p[2]));
            String   name = a0 instanceof String ? ((String) a0).trim() : "";
            if (name.isEmpty()) name = "CH " + Integer.parseInt(ch);
            channelNames.put(ch, name);
            emitChannelNames();
            return;
        }

        // /dca/N/config/name
        if (addr.matches("^/dca/\\d+/config/name$")) {
            String[] p    = addr.split("/");
            String   dca  = String.format("%02d", Integer.parseInt(p[2]));
            String   name = a0 instanceof String ? ((String) a0).trim() : "";
            if (name.isEmpty()) name = "DCA " + Integer.parseInt(dca);
            dcaNames.put(dca, name);
            emitDcaNames();
            return;
        }

        // /dca/N/on  — DCA group mute (1=active, 0=muted)
        if (addr.matches("^/dca/\\d+/on$")) {
            String[] p      = addr.split("/");
            int      dcaIdx = Integer.parseInt(p[2]) - 1; // 0-based
            String   dca    = String.format("%02d", dcaIdx + 1);
            boolean  on     = oscBool(a0);
            dcaOn.put(dca, on);
            mainHandler.post(() -> listener.onDcaOn(dca, on));
            // Recompute effective mute for all channels assigned to this DCA group
            for (Map.Entry<String, Integer> e : chDcaMask.entrySet()) {
                if ((e.getValue() & (1 << dcaIdx)) != 0) {
                    emitEffectiveChannelOn(e.getKey());
                }
            }
            return;
        }

        // /ch/NN/mix/on  — channel master mute (distinct from /ch/NN/mix/MM/on per-bus send)
        if (addr.matches("^/ch/\\d+/mix/on$")) {
            String[] p  = addr.split("/");
            String   ch = String.format("%02d", Integer.parseInt(p[2]));
            channelOwnOn.put(ch, oscBool(a0));
            emitEffectiveChannelOn(ch);
            return;
        }

        // /ch/NN/grp/dca  — DCA group assignment bitmask (bit0=DCA1 … bit7=DCA8)
        if (addr.matches("^/ch/\\d+/grp/dca$")) {
            String[] p  = addr.split("/");
            String   ch = String.format("%02d", Integer.parseInt(p[2]));
            int      mask = (a0 instanceof Integer) ? (Integer) a0
                          : (a0 instanceof Float)   ? Math.round((Float) a0) : 0;
            chDcaMask.put(ch, mask);
            emitEffectiveChannelOn(ch); // re-check with new DCA assignment
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

        // /auxin/NN/config/name
        if (addr.matches("^/auxin/\\d+/config/name$")) {
            String[] p    = addr.split("/");
            String   ch   = p[2];
            String   name = a0 instanceof String ? ((String) a0).trim() : "";
            if (name.isEmpty()) name = "AuxIn " + Integer.parseInt(ch);
            auxInNames.put(ch, name);
            emitAuxInNames();
            return;
        }

        // /fxrtn/NN/config/name — map OSC pair to logical ch 01-04
        if (addr.matches("^/fxrtn/\\d+/config/name$")) {
            String[] p      = addr.split("/");
            String   logCh  = fxOscToLogical(Integer.parseInt(p[2]));
            String   name   = a0 instanceof String ? ((String) a0).trim() : "";
            if (name.isEmpty()) {
                name = "FxRtn " + Integer.parseInt(logCh);
            }
            fxRtnNames.put(logCh, name);
            emitFxRtnNames();
            return;
        }

        // /auxin/NN/mix/on — master mute (distinct from /auxin/NN/mix/MM/on per-bus send)
        if (addr.matches("^/auxin/\\d+/mix/on$")) {
            String[] p  = addr.split("/");
            String   ch = String.format("%02d", Integer.parseInt(p[2]));
            boolean  on = oscBool(a0);
            auxInOn.put(ch, on);
            mainHandler.post(() -> listener.onAuxInOn(ch, on));
            return;
        }

        // /fxrtn/NN/mix/on — pair leaders only (odd OSC ch)
        if (addr.matches("^/fxrtn/\\d+/mix/on$")) {
            String[] p  = addr.split("/");
            int oscNum  = Integer.parseInt(p[2]);
            if (oscNum % 2 == 0) return;
            String   ch = fxOscToLogical(oscNum);
            boolean  on = oscBool(a0);
            fxRtnOn.put(ch, on);
            mainHandler.post(() -> listener.onFxRtnOn(ch, on));
            return;
        }

        // /auxin/NN/mix/MM/level — AuxIn send level to bus MM
        if (addr.matches("^/auxin/\\d+/mix/\\d+/level$")) {
            String[] p     = addr.split("/");
            String   ch    = String.format("%02d", Integer.parseInt(p[2]));
            String   bus   = String.format("%02d", Integer.parseInt(p[4]));
            float    level = a0 instanceof Float ? (Float) a0 : 0.75f;
            String   key   = ch + ":" + bus;
            if (!auxInSendLevels.containsKey(key)) auxInSendLevels.put(key, new double[]{0.75, 1});
            auxInSendLevels.get(key)[0] = level;
            mainHandler.post(() -> listener.onAuxInSendLevel(ch, bus, level, auxInSendLevels.get(key)[1] != 0));
            return;
        }

        // /auxin/NN/mix/MM/on — AuxIn send on/off to bus MM
        if (addr.matches("^/auxin/\\d+/mix/\\d+/on$")) {
            String[] p   = addr.split("/");
            String   ch  = String.format("%02d", Integer.parseInt(p[2]));
            String   bus = String.format("%02d", Integer.parseInt(p[4]));
            boolean  on  = oscBool(a0);
            String   key = ch + ":" + bus;
            if (!auxInSendLevels.containsKey(key)) auxInSendLevels.put(key, new double[]{0.75, 1});
            auxInSendLevels.get(key)[1] = on ? 1 : 0;
            mainHandler.post(() -> listener.onAuxInSendOn(ch, bus, auxInSendLevels.get(key)[0], on));
            return;
        }

        // /fxrtn/NN/mix/MM/level — map OSC pair to logical ch 01-04
        if (addr.matches("^/fxrtn/\\d+/mix/\\d+/level$")) {
            String[] p     = addr.split("/");
            String   ch    = fxOscToLogical(Integer.parseInt(p[2]));
            String   bus   = String.format("%02d", Integer.parseInt(p[4]));
            float    level = a0 instanceof Float ? (Float) a0 : 0.75f;
            String   key   = ch + ":" + bus;
            if (!fxRtnSendLevels.containsKey(key)) fxRtnSendLevels.put(key, new double[]{0.75, 1});
            fxRtnSendLevels.get(key)[0] = level;
            mainHandler.post(() -> listener.onFxRtnSendLevel(ch, bus, level, fxRtnSendLevels.get(key)[1] != 0));
            return;
        }

        // /fxrtn/NN/mix/MM/on — map OSC pair to logical ch 01-04
        if (addr.matches("^/fxrtn/\\d+/mix/\\d+/on$")) {
            String[] p   = addr.split("/");
            String   ch  = fxOscToLogical(Integer.parseInt(p[2]));
            String   bus = String.format("%02d", Integer.parseInt(p[4]));
            boolean  on  = oscBool(a0);
            String   key = ch + ":" + bus;
            if (!fxRtnSendLevels.containsKey(key)) fxRtnSendLevels.put(key, new double[]{0.75, 1});
            fxRtnSendLevels.get(key)[1] = on ? 1 : 0;
            mainHandler.post(() -> listener.onFxRtnSendOn(ch, bus, fxRtnSendLevels.get(key)[0], on));
            return;
        }

        // /bus/NN/config/ms  — 0=ST (linked stereo), 1=MS, 2=M (mono)
        if (addr.matches("^/bus/\\d+/config/ms$")) {
            String[] p    = addr.split("/");
            String   bus  = String.format("%02d", Integer.parseInt(p[2]));
            int msVal;
            if (a0 instanceof Integer) msVal = (Integer) a0;
            else if (a0 instanceof Float) msVal = Math.round((Float) a0);
            else msVal = 1;
            boolean mono = msVal != 0; // only ST (0) = linked stereo
            Log.i(TAG, "BUS_MS bus=" + bus + " raw=" + (a0 != null ? a0.getClass().getSimpleName()+"="+a0 : "null") + " msVal=" + msVal + " mono=" + mono);
            busMono.put(bus, mono);
            emitBusConfig();
            return;
        }

        // /ch/NN/mix/MM/level
        if (addr.matches("^/ch/\\d+/mix/\\d+/level$")) {
            String[] p     = addr.split("/");
            String   ch    = String.format("%02d", Integer.parseInt(p[2]));
            String   bus   = String.format("%02d", Integer.parseInt(p[4]));
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
            String   ch  = String.format("%02d", Integer.parseInt(p[2]));
            String   bus = String.format("%02d", Integer.parseInt(p[4]));
            boolean  on  = oscBool(a0);
            String   key = ch + ":" + bus;
            if (!sendLevels.containsKey(key)) sendLevels.put(key, new double[]{0.75, 1});
            sendLevels.get(key)[1] = on ? 1 : 0;
            mainHandler.post(() -> listener.onSendOn(ch, bus, sendLevels.get(key)[0], on));
            return;
        }

        // /ch/NN/mix/MM/pre  — 0=post-fader, 1=pre-fader
        if (addr.matches("^/ch/\\d+/mix/\\d+/pre$")) {
            String[] p   = addr.split("/");
            String   ch  = String.format("%02d", Integer.parseInt(p[2]));
            String   bus = String.format("%02d", Integer.parseInt(p[4]));
            boolean  pre = oscBool(a0);
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
            String   bus = String.format("%02d", Integer.parseInt(p[2]));
            boolean  on  = oscBool(a0);
            if (!busLevels.containsKey(bus)) busLevels.put(bus, new double[]{0.75, 1});
            busLevels.get(bus)[1] = on ? 1 : 0;
            mainHandler.post(() -> listener.onBusOn(bus, busLevels.get(bus)[0], on));
            return;
        }

        // /meters/1 — 32 input channels only; float[32+] are NOT AuxIn (produce phantom signal)
        if (addr.equals("/meters/1") && a0 instanceof byte[]) {
            byte[] blob1 = (byte[]) a0;
            JSObject m = parseMeterBlob(blob1, 32);
            if (m != null) mainHandler.post(() -> listener.onInputMeters(m));
            return;
        }

        // /meters/2: float[0-7]=FX Send levels; float[8-15]=FxRtn 1-4 stereo L+R output
        // Layout: FX1L=[8],FX1R=[9], FX2L=[10],FX2R=[11], FX3L=[12],FX3R=[13], FX4L=[14],FX4R=[15]
        if (addr.equals("/meters/2") && a0 instanceof byte[]) {
            byte[] blob2 = (byte[]) a0;
            if (blob2.length >= 8) {
                int cnt2 = ByteBuffer.wrap(blob2, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
                int exp2 = cnt2 * 4;
                int off2 = (exp2 > 0 && exp2 <= blob2.length - 4) ? 4 : 0;


                JSObject fxRtn = new JSObject();
                for (int i = 0; i < 4; i++) {
                    int loL = off2 + (8 + i * 2) * 4;
                    int loR = off2 + (8 + i * 2 + 1) * 4;
                    if (loR + 4 > blob2.length) break;
                    float vL = ByteBuffer.wrap(blob2, loL, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
                    float vR = ByteBuffer.wrap(blob2, loR, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
                    double db = linToDbFS(Math.max(vL, vR));
                    String key = String.format("%02d", i + 1);
                    JSObject ch = new JSObject();
                    ch.put("left", db); ch.put("right", db);
                    fxRtn.put(key, ch);
                }

                if (fxRtn.length() > 0) mainHandler.post(() -> listener.onFxRtnMeters(fxRtn));
            }
            return;
        }

        // /meters/3 is GEQ/dynamics data on M32R, NOT AuxIn — produces phantom signal.

        // /meters/5  — 16 bus channels
        if (addr.equals("/meters/5") && a0 instanceof byte[]) {
            JSObject m = parseMeterBlob((byte[]) a0, 16);
            if (m != null) mainHandler.post(() -> listener.onBusMeters(m));
            return;
        }

        // ── Catch-all: log unhandled non-meter bus/config messages ──
        if (!addr.startsWith("/meters") && !addr.startsWith("/ch/") && !addr.startsWith("/auxin/") && !addr.startsWith("/fxrtn/")) {
            String a0Str = a0 == null ? "null" : (a0.getClass().getSimpleName() + "=" + a0);
            Log.i(TAG, "M32_OSC addr=" + addr + " a0=" + a0Str);
        }
    }

    // ── Meter blob parser ─────────────────────────────────────
    // Blob: 4-byte LE int32 count + count × LE float32
    // M32 may send mono (1 float/ch) or stereo pairs (2 floats/ch).
    // Detect by comparing countLE to numCh: if count >= numCh*2 → stereo, else → mono.

    private static JSObject parseMeterBlob(byte[] blob, int numCh) {
        if (blob == null || blob.length < 8) return null;
        try {
            int countLE  = ByteBuffer.wrap(blob, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            int expected = countLE * 4;
            int offset   = (expected > 0 && expected <= blob.length - 4) ? 4 : 0;

            // Stereo only when count header is valid (offset=4) and exactly 2 floats/ch.
            // If offset=0 (no valid LE header), fall back to blob-size detection.
            // Avoids false-stereo on extended mono blobs (e.g. 72 floats for 32 ch).
            boolean stereo = (offset == 4)
                ? countLE == numCh * 2
                : blob.length >= numCh * 8;
            int stride = stereo ? 8 : 4;

            Log.d(TAG, "parseMeterBlob: blobLen=" + blob.length + " countLE=" + countLE
                    + " numCh=" + numCh + " stereo=" + stereo + " offset=" + offset);

            JSObject result = new JSObject();
            for (int i = 0; i < numCh; i++) {
                int lo = offset + i * stride;
                if (lo + 4 > blob.length) break;
                float lv = ByteBuffer.wrap(blob, lo, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
                float rv = lv;
                if (stereo) {
                    int ro = lo + 4;
                    if (ro + 4 <= blob.length)
                        rv = ByteBuffer.wrap(blob, ro, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
                }
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
        return Math.max(-90, Math.round(10 * Math.log10(v) * 10.0) / 10.0);
    }

    // ── Initial queries ───────────────────────────────────────

    private void queryAllNames() {
        // Stagger queries in batches — M32R drops responses when flooded.
        // Delay 150ms after /xremote so M32 registers subscription before queries.
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 1; i <= 8; i++) {
                String ch = String.format("%02d", i);
                sendNoArgs("/ch/" + ch + "/config/name");
                sendNoArgs("/ch/" + ch + "/mix/on");
                sendNoArgs("/ch/" + ch + "/grp/dca");
            }
        }, 150, TimeUnit.MILLISECONDS));
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 9; i <= 16; i++) {
                String ch = String.format("%02d", i);
                sendNoArgs("/ch/" + ch + "/config/name");
                sendNoArgs("/ch/" + ch + "/mix/on");
                sendNoArgs("/ch/" + ch + "/grp/dca");
            }
        }, 300, TimeUnit.MILLISECONDS));
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 17; i <= 24; i++) {
                String ch = String.format("%02d", i);
                sendNoArgs("/ch/" + ch + "/config/name");
                sendNoArgs("/ch/" + ch + "/mix/on");
                sendNoArgs("/ch/" + ch + "/grp/dca");
            }
        }, 450, TimeUnit.MILLISECONDS));
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 25; i <= 32; i++) {
                String ch = String.format("%02d", i);
                sendNoArgs("/ch/" + ch + "/config/name");
                sendNoArgs("/ch/" + ch + "/mix/on");
                sendNoArgs("/ch/" + ch + "/grp/dca");
            }
        }, 600, TimeUnit.MILLISECONDS));
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 1; i <= 8; i++) {
                String ch = String.format("%02d", i);
                sendNoArgs("/auxin/" + ch + "/config/name");
                sendNoArgs("/auxin/" + ch + "/mix/on");
            }
            for (int i = 1; i <= 4; i++) {
                String osc = fxLogicalToOsc(String.format("%02d", i));
                sendNoArgs("/fxrtn/" + osc + "/config/name");
                sendNoArgs("/fxrtn/" + osc + "/mix/on");
            }
        }, 750, TimeUnit.MILLISECONDS));
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 1; i <= 8; i++) {
                sendNoArgs("/dca/" + i + "/config/name");
                sendNoArgs("/dca/" + i + "/on");
            }
        }, 900, TimeUnit.MILLISECONDS));
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 1; i <= 16; i++) {
                String b = String.format("%02d", i);
                sendNoArgs("/bus/" + b + "/config/name");
                sendNoArgs("/bus/" + b + "/config/ms");
                sendNoArgs("/bus/" + b + "/mix/level");
                sendNoArgs("/bus/" + b + "/mix/on");
            }
        }, 1100, TimeUnit.MILLISECONDS));
        // Re-query bus stereo config
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 1; i <= 16; i++) {
                sendNoArgs("/bus/" + String.format("%02d", i) + "/config/ms");
            }
        }, 2000, TimeUnit.MILLISECONDS));
        // Full re-query of all names — catches any responses M32 dropped in the first pass
        queryFutures.add(scheduler.schedule(this::retryQueryNames, 3000, TimeUnit.MILLISECONDS));
    }

    private void retryQueryNames() {
        for (int i = 1; i <= 32; i++) {
            String ch = String.format("%02d", i);
            sendNoArgs("/ch/" + ch + "/config/name");
            sendNoArgs("/ch/" + ch + "/mix/on");
            sendNoArgs("/ch/" + ch + "/grp/dca");
        }
        queryFutures.add(scheduler.schedule(() -> {
            for (int i = 1; i <= 8; i++) {
                String ch = String.format("%02d", i);
                sendNoArgs("/auxin/" + ch + "/config/name");
                sendNoArgs("/auxin/" + ch + "/mix/on");
            }
            for (int i = 1; i <= 4; i++) {
                String osc = fxLogicalToOsc(String.format("%02d", i));
                sendNoArgs("/fxrtn/" + osc + "/config/name");
                sendNoArgs("/fxrtn/" + osc + "/mix/on");
            }
            for (int i = 1; i <= 8; i++) {
                sendNoArgs("/dca/" + i + "/config/name");
                sendNoArgs("/dca/" + i + "/on");
            }
        }, 200, TimeUnit.MILLISECONDS));
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
        for (int i = 1; i <= 8; i++) {
            String ch = String.format("%02d", i);
            sendNoArgs("/auxin/" + ch + "/mix/" + bus + "/level");
            sendNoArgs("/auxin/" + ch + "/mix/" + bus + "/on");
        }
        for (int i = 1; i <= 4; i++) {
            String osc = fxLogicalToOsc(String.format("%02d", i));
            sendNoArgs("/fxrtn/" + osc + "/mix/" + bus + "/level");
            sendNoArgs("/fxrtn/" + osc + "/mix/" + bus + "/on");
        }
    }

    // ── Control API ───────────────────────────────────────────

    public void setChannelOn(String ch, boolean on) {
        sendInt("/ch/" + ch + "/mix/on", on ? 1 : 0);
        channelOwnOn.put(ch, on);
        emitEffectiveChannelOn(ch);
    }

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

    public void setAuxInSendLevel(String ch, String bus, float level) {
        float clamped = Math.min(1f, Math.max(0f, level));
        sendFloat("/auxin/" + ch + "/mix/" + bus + "/level", clamped);
        String key = ch + ":" + bus;
        if (!auxInSendLevels.containsKey(key)) auxInSendLevels.put(key, new double[]{0.75, 1});
        auxInSendLevels.get(key)[0] = clamped;
        mainHandler.post(() -> listener.onAuxInSendLevel(ch, bus, clamped, auxInSendLevels.get(key)[1] != 0));
    }

    public void setAuxInSendOn(String ch, String bus, boolean on) {
        sendInt("/auxin/" + ch + "/mix/" + bus + "/on", on ? 1 : 0);
        String key = ch + ":" + bus;
        if (!auxInSendLevels.containsKey(key)) auxInSendLevels.put(key, new double[]{0.75, 1});
        auxInSendLevels.get(key)[1] = on ? 1 : 0;
        mainHandler.post(() -> listener.onAuxInSendOn(ch, bus, auxInSendLevels.get(key)[0], on));
    }

    public void setFxRtnSendLevel(String ch, String bus, float level) {
        float clamped = Math.min(1f, Math.max(0f, level));
        String osc = fxLogicalToOsc(ch);
        sendFloat("/fxrtn/" + osc + "/mix/" + bus + "/level", clamped);
        String key = ch + ":" + bus;
        if (!fxRtnSendLevels.containsKey(key)) fxRtnSendLevels.put(key, new double[]{0.75, 1});
        fxRtnSendLevels.get(key)[0] = clamped;
        mainHandler.post(() -> listener.onFxRtnSendLevel(ch, bus, clamped, fxRtnSendLevels.get(key)[1] != 0));
    }

    public void setFxRtnSendOn(String ch, String bus, boolean on) {
        String osc = fxLogicalToOsc(ch);
        sendInt("/fxrtn/" + osc + "/mix/" + bus + "/on", on ? 1 : 0);
        String key = ch + ":" + bus;
        if (!fxRtnSendLevels.containsKey(key)) fxRtnSendLevels.put(key, new double[]{0.75, 1});
        fxRtnSendLevels.get(key)[1] = on ? 1 : 0;
        mainHandler.post(() -> listener.onFxRtnSendOn(ch, bus, fxRtnSendLevels.get(key)[0], on));
    }

    // ── FxRtn stereo pair mapping ────────────────────────────
    // M32 has 8 FxRtn OSC channels in 4 stereo pairs (01+02, 03+04, 05+06, 07+08).
    // App shows 4 logical channels (01-04), each mapping to one pair leader.
    private static String fxLogicalToOsc(String logCh) {
        return String.format("%02d", (Integer.parseInt(logCh) - 1) * 2 + 1);
    }
    private static String fxOscToLogical(int oscCh) {
        return String.format("%02d", (int) Math.ceil(oscCh / 2.0));
    }

    // ── OSC boolean helper ────────────────────────────────────
    // M32R sometimes sends bool params as 'i' (Integer) and sometimes as 'f' (Float).
    private static boolean oscBool(Object v) {
        if (v instanceof Integer) return ((Integer) v) == 1;
        if (v instanceof Float)   return Math.round((Float) v) == 1;
        return false;
    }

    // ── DCA-aware effective mute ──────────────────────────────
    private boolean isChannelDcaMuted(String ch) {
        int mask = chDcaMask.getOrDefault(ch, 0);
        if (mask == 0) return false;
        for (int i = 0; i < 8; i++) {
            if ((mask & (1 << i)) != 0) {
                Boolean active = dcaOn.get(String.format("%02d", i + 1));
                if (active != null && !active) return true; // DCA is muted
            }
        }
        return false;
    }

    private void emitEffectiveChannelOn(String ch) {
        Boolean ownOnVal = channelOwnOn.get(ch);
        if (ownOnVal == null) return; // own mute not yet known — wait for /ch/NN/mix/on response
        boolean ownOn     = ownOnVal;
        boolean dcaMuted  = isChannelDcaMuted(ch);
        boolean effective = ownOn && !dcaMuted;
        channelOn.put(ch, effective);
        mainHandler.post(() -> listener.onChannelOn(ch, effective));
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

    private void emitAuxInNames() {
        JSObject obj = new JSObject();
        for (Map.Entry<String, String> e : auxInNames.entrySet()) obj.put(e.getKey(), e.getValue());
        mainHandler.post(() -> listener.onAuxInNames(obj));
    }

    private void emitFxRtnNames() {
        JSObject obj = new JSObject();
        for (Map.Entry<String, String> e : fxRtnNames.entrySet()) obj.put(e.getKey(), e.getValue());
        mainHandler.post(() -> listener.onFxRtnNames(obj));
    }

    private void emitDcaNames() {
        JSObject obj = new JSObject();
        for (Map.Entry<String, String> e : dcaNames.entrySet()) obj.put(e.getKey(), e.getValue());
        mainHandler.post(() -> listener.onDcaNames(obj));
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
