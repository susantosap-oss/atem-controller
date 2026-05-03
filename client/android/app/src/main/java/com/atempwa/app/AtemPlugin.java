package com.atempwa.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AtemPlugin — Capacitor bridge ke AtemConnection.
 * Expose metode connect/disconnect dan semua ATEM commands ke JavaScript.
 * Events: atem:status, atem:audioState, atem:videoState, atem:mediaState, atem:vuMeter
 */
@CapacitorPlugin(name = "Atem")
public class AtemPlugin extends Plugin implements AtemConnection.Listener {

    private AtemConnection atem;

    @PluginMethod
    public void connect(PluginCall call) {
        String ip = call.getString("ip");
        if (ip == null || ip.isEmpty()) {
            call.reject("IP is required");
            return;
        }
        if (atem != null) {
            atem.disconnect();
        }
        atem = new AtemConnection(ip, this, getContext());
        atem.connect();
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (atem != null) {
            atem.disconnect();
            atem = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void setChannelGain(PluginCall call) {
        if (!checkConnected(call)) return;
        int index = call.getInt("index", 0);
        double gain = call.getDouble("gain", 0.0);
        atem.sendAudioInputGain(index, gain);
        call.resolve();
    }

    @PluginMethod
    public void setChannelMixOption(PluginCall call) {
        if (!checkConnected(call)) return;
        int index = call.getInt("index", 0);
        int mixOption = call.getInt("mixOption", 0);
        atem.sendAudioInputMixOption(index, mixOption);
        call.resolve();
    }

    @PluginMethod
    public void setChannelBalance(PluginCall call) {
        if (!checkConnected(call)) return;
        int index = call.getInt("index", 0);
        double balance = call.getDouble("balance", 0.0);
        atem.sendAudioInputBalance(index, balance);
        call.resolve();
    }

    @PluginMethod
    public void setMasterGain(PluginCall call) {
        if (!checkConnected(call)) return;
        double gain = call.getDouble("gain", 0.0);
        atem.sendMasterGain(gain);
        call.resolve();
    }

    @PluginMethod
    public void setMasterBalance(PluginCall call) {
        if (!checkConnected(call)) return;
        double balance = call.getDouble("balance", 0.0);
        atem.sendMasterBalance(balance);
        call.resolve();
    }

    @PluginMethod
    public void setPreviewInput(PluginCall call) {
        if (!checkConnected(call)) return;
        int source = call.getInt("source", 0);
        atem.sendPreviewInput(source);
        call.resolve();
    }

    @PluginMethod
    public void setProgramInput(PluginCall call) {
        if (!checkConnected(call)) return;
        int source = call.getInt("source", 0);
        atem.sendProgramInput(source);
        call.resolve();
    }

    @PluginMethod
    public void performAuto(PluginCall call) {
        if (!checkConnected(call)) return;
        atem.sendAutoTransition();
        call.resolve();
    }

    @PluginMethod
    public void performCut(PluginCall call) {
        if (!checkConnected(call)) return;
        atem.sendCut();
        call.resolve();
    }

    @PluginMethod
    public void setTransitionStyle(PluginCall call) {
        if (!checkConnected(call)) return;
        int style = call.getInt("style", 0);
        atem.sendTransitionStyle(style);
        call.resolve();
    }

    @PluginMethod
    public void setTransitionPosition(PluginCall call) {
        if (!checkConnected(call)) return;
        int position = call.getInt("position", 0);
        atem.sendTransitionPosition(position);
        call.resolve();
    }

    @PluginMethod
    public void performFTB(PluginCall call) {
        if (!checkConnected(call)) return;
        atem.sendFadeToBlack();
        call.resolve();
    }

    @PluginMethod
    public void setDSKOnAir(PluginCall call) {
        if (!checkConnected(call)) return;
        int keyerIndex = call.getInt("keyerIndex", 0);
        boolean onAir = Boolean.TRUE.equals(call.getBoolean("onAir", false));
        atem.sendDSKOnAir(keyerIndex, onAir);
        call.resolve();
    }

    @PluginMethod
    public void autoDSKTransition(PluginCall call) {
        if (!checkConnected(call)) return;
        int keyerIndex = call.getInt("keyerIndex", 0);
        atem.sendAutoDSK(keyerIndex);
        call.resolve();
    }

    @PluginMethod
    public void setMediaPlayerStill(PluginCall call) {
        if (!checkConnected(call)) return;
        int playerIndex = call.getInt("playerIndex", 0);
        int stillIndex = call.getInt("stillIndex", 0);
        atem.sendMediaPlayerSource(playerIndex, stillIndex);
        call.resolve();
    }

    // ── AtemConnection.Listener callbacks ─────────────────────────

    @Override
    public void onStatus(String status, String message, String ip) {
        JSObject data = new JSObject();
        data.put("status", status);
        data.put("message", message != null ? message : "");
        data.put("ip", ip != null ? ip : "");
        notifyListeners("atem:status", data);
    }

    @Override
    public void onAudioState(JSObject state) {
        notifyListeners("atem:audioState", state);
    }

    @Override
    public void onVideoState(JSObject state) {
        notifyListeners("atem:videoState", state);
    }

    @Override
    public void onVuMeter(JSObject levels) {
        notifyListeners("atem:vuMeter", levels);
    }

    @Override
    public void onMediaState(JSObject state) {
        notifyListeners("atem:mediaState", state);
    }

    // ── helpers ───────────────────────────────────────────────────

    private boolean checkConnected(PluginCall call) {
        if (atem == null || !atem.isConnected()) {
            call.reject("ATEM not connected");
            return false;
        }
        return true;
    }
}
