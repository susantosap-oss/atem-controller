package com.atempwa.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * M32Plugin — Capacitor bridge untuk M32Connection.
 * Expose metode connect/disconnect dan control commands ke JavaScript.
 * Events: m32:status, m32:channelNames, m32:busNames, m32:busConfig,
 *         m32:sendLevel, m32:sendOn, m32:busLevel, m32:busOn,
 *         m32:inputMeters, m32:busMeters
 */
@CapacitorPlugin(name = "M32")
public class M32Plugin extends Plugin implements M32Connection.Listener {

    private M32Connection m32;

    @PluginMethod
    public void connect(PluginCall call) {
        String ip = call.getString("ip");
        if (ip == null || ip.isEmpty()) {
            call.reject("IP is required");
            return;
        }
        if (m32 != null) m32.disconnect();
        m32 = new M32Connection(ip, this);
        m32.connect();
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (m32 != null) { m32.disconnect(); m32 = null; }
        call.resolve();
    }

    @PluginMethod
    public void setChannelSendLevel(PluginCall call) {
        if (!checkConnected(call)) return;
        String ch    = call.getString("ch",  "01");
        String bus   = call.getString("bus", "01");
        float  level = call.getFloat("level", 0.75f);
        m32.setChannelSendLevel(ch, bus, level);
        call.resolve();
    }

    @PluginMethod
    public void setChannelSendOn(PluginCall call) {
        if (!checkConnected(call)) return;
        String  ch  = call.getString("ch",  "01");
        String  bus = call.getString("bus", "01");
        boolean on  = Boolean.TRUE.equals(call.getBoolean("on", true));
        m32.setChannelSendOn(ch, bus, on);
        call.resolve();
    }

    @PluginMethod
    public void setBusLevel(PluginCall call) {
        if (!checkConnected(call)) return;
        String bus   = call.getString("bus", "01");
        float  level = call.getFloat("level", 0.75f);
        m32.setBusLevel(bus, level);
        call.resolve();
    }

    @PluginMethod
    public void setBusOn(PluginCall call) {
        if (!checkConnected(call)) return;
        String  bus = call.getString("bus", "01");
        boolean on  = Boolean.TRUE.equals(call.getBoolean("on", true));
        m32.setBusOn(bus, on);
        call.resolve();
    }

    @PluginMethod
    public void queryBus(PluginCall call) {
        if (!checkConnected(call)) return;
        int busNum = call.getInt("bus", 1);
        m32.queryBus(busNum);
        call.resolve();
    }

    // ── M32Connection.Listener callbacks ─────────────────────────

    @Override
    public void onStatus(String status, String ip, String error) {
        JSObject data = new JSObject();
        data.put("status", status);
        data.put("ip", ip != null ? ip : "");
        if (error != null) data.put("error", error);
        notifyListeners("m32:status", data);
    }

    @Override
    public void onChannelNames(JSObject names) {
        notifyListeners("m32:channelNames", names);
    }

    @Override
    public void onBusNames(JSObject names) {
        notifyListeners("m32:busNames", names);
    }

    @Override
    public void onBusConfig(JSObject config) {
        notifyListeners("m32:busConfig", config);
    }

    @Override
    public void onSendLevel(String ch, String bus, double level, boolean on) {
        JSObject data = new JSObject();
        data.put("ch",    ch);
        data.put("bus",   bus);
        data.put("level", level);
        data.put("on",    on);
        notifyListeners("m32:sendLevel", data);
    }

    @Override
    public void onSendOn(String ch, String bus, double level, boolean on) {
        JSObject data = new JSObject();
        data.put("ch",    ch);
        data.put("bus",   bus);
        data.put("level", level);
        data.put("on",    on);
        notifyListeners("m32:sendOn", data);
    }

    @Override
    public void onBusLevel(String bus, double level, boolean on) {
        JSObject data = new JSObject();
        data.put("bus",   bus);
        data.put("level", level);
        data.put("on",    on);
        notifyListeners("m32:busLevel", data);
    }

    @Override
    public void onBusOn(String bus, double level, boolean on) {
        JSObject data = new JSObject();
        data.put("bus",   bus);
        data.put("level", level);
        data.put("on",    on);
        notifyListeners("m32:busOn", data);
    }

    @Override
    public void onInputMeters(JSObject meters) {
        notifyListeners("m32:inputMeters", meters);
    }

    @Override
    public void onBusMeters(JSObject meters) {
        notifyListeners("m32:busMeters", meters);
    }

    // ── helpers ───────────────────────────────────────────────────

    private boolean checkConnected(PluginCall call) {
        if (m32 == null || !m32.isConnected()) {
            call.reject("M32 not connected");
            return false;
        }
        return true;
    }
}
