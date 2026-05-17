/**
 * ATEM Manager — wraps atem-connection library.
 * Handles connect/disconnect lifecycle, emits events to bridge.
 */
const { Atem } = require('atem-connection');
const { EventEmitter } = require('events');

// Re-send startFairlightMixerSendLevels every 4 min — ATEM firmware has a ~5 min stream TTL.
const LEVEL_STREAM_RENEW_MS = 4 * 60 * 1000;

class AtemManager extends EventEmitter {
  constructor() {
    super();
    this._atem = null;
    this._ip = null;
    this._status = 'disconnected'; // 'connecting' | 'connected' | 'disconnected' | 'error'
    this._reconnectTimer = null;
    this._levelTimer = null;   // periodic Fairlight stream renewal
    this._state = null;
    this._levelAccum = {}; // accumulates stereo sub-channel levels per input index
    this._defaultApplied = false; // on first audioState build, non-Mic1 channels start silent
  }

  get status() { return this._status; }
  get ip() { return this._ip; }
  get state() { return this._state; }

  async connect(ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      this.emit('status', { status: 'error', message: 'Invalid IP address', ip });
      return;
    }

    // Disconnect existing before reconnecting
    if (this._atem) {
      await this.disconnect(false);
    }

    this._ip = ip;
    this._setStatus('connecting');

    this._atem = new Atem();

    this._atem.on('connected', () => {
      clearTimeout(this._reconnectTimer);
      this._state = this._atem.state;
      this._setStatus('connected');

      // Debug: log which audio system is active
      console.log('[ATEM] fairlight present:', !!this._state?.fairlight,
        '| inputs:', Object.keys(this._state?.fairlight?.inputs ?? {}).length,
        '| audio present:', !!this._state?.audio);

      this.emit('audioState', this._buildAudioState());
      const ms = this._buildMediaState();
      if (ms) this.emit('mediaState', ms);
      const vs = this._buildVideoState();
      if (vs) this.emit('videoState', vs);

      // Start Fairlight VU meter streaming + schedule periodic renewal
      if (this._isFairlight()) {
        this._atem.startFairlightMixerSendLevels().catch(e =>
          console.warn('[ATEM] startFairlightMixerSendLevels failed:', e?.message)
        );
        clearInterval(this._levelTimer);
        this._levelTimer = setInterval(() => {
          if (this._isConnected() && this._isFairlight()) {
            this._atem.startFairlightMixerSendLevels().catch(e =>
              console.warn('[ATEM] Level stream renewal failed:', e?.message)
            );
          }
        }, LEVEL_STREAM_RENEW_MS);
      }
    });

    // Fairlight level events (bypass stateChanged — emitted by atem-connection directly)
    this._atem.on('levelChanged', (levelData) => {
      if (!this._isConnected()) return;
      const levels = {};
      if (levelData.type === 'source') {
        const l = levelData.levels;
        const key = String(levelData.index);
        if (!this._levelAccum[key]) {
          this._levelAccum[key] = { left: -60, right: -60, peakLeft: -60, peakRight: -60 };
        }
        const acc = this._levelAccum[key];
        // Stereo channels send TWO FMLv packets, both with source < 0:
        //   left sub-channel:  leftLevel=active, rightLevel=-100 (silent)
        //   right sub-channel: leftLevel=-100,   rightLevel=active
        // Accumulate per field: only overwrite if the value is above -90 (i.e. not silent filler).
        // Mono channels send one packet where both leftLevel and rightLevel are active.
        if (levelData.source < 0n) {
          const lv = l.leftLevel  / 100;
          const rv = l.rightLevel / 100;
          if (lv > -90) { acc.left     = Math.max(lv, -60); acc.peakLeft  = Math.max(l.leftPeak  / 100, -60); }
          if (rv > -90) { acc.right    = Math.max(rv, -60); acc.peakRight = Math.max(l.rightPeak / 100, -60); }
        } else {
          acc.right     = Math.max(l.leftLevel / 100, -60);
          acc.peakRight = Math.max(l.leftPeak  / 100, -60);
        }
        levels[key] = { ...acc };
      } else if (levelData.type === 'master') {
        const l = levelData.levels;
        levels['master'] = {
          left:      Math.max(l.leftLevel  / 100, -60),
          right:     Math.max(l.rightLevel / 100, -60),
          peakLeft:  Math.max(l.leftPeak   / 100, -60),
          peakRight: Math.max(l.rightPeak  / 100, -60),
        };
      }
      if (Object.keys(levels).length > 0) this.emit('vuMeter', levels);
    });

    this._atem.on('disconnected', () => {
      this._setStatus('disconnected');
      this._scheduleReconnect();
    });

    this._atem.on('stateChanged', (state, pathKeys) => {
      this._state = state;
      this._handleStateChange(pathKeys);
    });

    this._atem.on('error', (err) => {
      console.error('[ATEM] Error:', err.message);
      this._setStatus('error', err.message);
      this._scheduleReconnect();
    });

    // Connection timeout: 10s
    this._reconnectTimer = setTimeout(() => {
      if (this._status !== 'connected') {
        this._setStatus('error', 'Connection timeout');
      }
    }, 10000);

    try {
      await this._atem.connect(ip);
    } catch (err) {
      this._setStatus('error', err.message);
    }
  }

  async disconnect(clearIP = true) {
    clearTimeout(this._reconnectTimer);
    clearInterval(this._levelTimer);
    this._levelTimer = null;
    if (this._atem) {
      this._atem.removeAllListeners();
      try { await this._atem.disconnect(); } catch (_) {}
      this._atem = null;
    }
    if (clearIP) {
      this._ip = null;
      // Only reset blast-protection on manual disconnect — on auto-reconnect
      // we keep _defaultApplied = true so ATEM's stored gains are sent as-is.
      this._defaultApplied = false;
    }
    this._state = null;
    this._levelAccum = {};
    this._setStatus('disconnected');
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    if (!this._ip) return;
    console.log('[ATEM] Reconnecting in 1.5s...');
    this._reconnectTimer = setTimeout(() => {
      if (this._status !== 'connected' && this._ip) {
        this.connect(this._ip);
      }
    }, 1500);
  }

  _setStatus(status, message = '') {
    this._status = status;
    this.emit('status', { status, message, ip: this._ip });
  }

  _handleStateChange(pathKeys) {
    if (!pathKeys || !pathKeys.length) return;

    // Emit full audio state for non-level audio/fairlight paths OR when input names change
    const audioStatePaths = pathKeys.filter(
      k => (k.startsWith('audio') && !k.includes('levels')) ||
           (k.startsWith('fairlight') && !k.includes('levels')) ||
           k.startsWith('inputs.')
    );
    if (audioStatePaths.length > 0) {
      this.emit('audioState', this._buildAudioState());
    }

    // Emit media state when media players or still pool change
    const mediaStatePaths = pathKeys.filter(k => k.startsWith('media'));
    if (mediaStatePaths.length > 0) {
      const ms = this._buildMediaState();
      if (ms) this.emit('mediaState', ms);
    }

    // Emit video state when ME inputs/transition change or input labels change
    const videoStatePaths = pathKeys.filter(k => k.startsWith('video') || k.startsWith('inputs.'));
    if (videoStatePaths.length > 0) {
      const vs = this._buildVideoState();
      if (vs) this.emit('videoState', vs);
    }

    // Emit VU meter data — throttled externally by socket-bridge
    const hasLevels = pathKeys.some(k => k.includes('levels') || k.includes('Level'));
    if (hasLevels && this._state?.audio) {
      const levels = this._buildLevels();
      if (levels) this.emit('vuMeter', levels);
    }
  }

  buildAudioState() { return this._buildAudioState(); }
  buildMediaState() { return this._buildMediaState(); }
  buildVideoState() { return this._buildVideoState(); }

  _isFairlight() {
    return this._state?.fairlight &&
      Object.keys(this._state.fairlight.inputs ?? {}).length > 0;
  }

  _getFairlightSourceKey(inputIndex) {
    const sources = this._state?.fairlight?.inputs?.[inputIndex]?.sources;
    if (!sources) return null;
    const keys = Object.keys(sources);
    return keys.length > 0 ? keys[0] : null;
  }

  _buildAudioState() {
    // Fairlight path (ATEM Mini Pro firmware 8.6+)
    if (this._isFairlight()) {
      const channels = {};
      for (const [idx, input] of Object.entries(this._state.fairlight.inputs)) {
        const sources = input?.sources ?? {};
        const srcKeys = Object.keys(sources);
        if (srcKeys.length === 0) continue;
        const props = sources[srcKeys[0]]?.properties ?? {};
        const gainDb = (props.faderGain ?? 0) / 100;
        // On first connect, non-Mic1 channels default to silent so no accidental audio blast.
        // After _defaultApplied is set, all subsequent state updates use actual ATEM values.
        const isMic1 = idx === '1301';
        const useActual = isMic1 || this._defaultApplied;
        channels[idx] = {
          gain:      useActual ? gainDb : -60,
          balance:   (props.balance  ?? 0) / 200,
          mixOption: useActual ? (props.mixOption ?? 0) : 0,  // 0 = MixOption.Off
          label:     this._getChannelLabel(Number(idx)),
        };
      }
      this._defaultApplied = true;
      // If channels populated, return Fairlight state
      if (Object.keys(channels).length > 0) {
        const masterProps = this._state.fairlight.master?.properties ?? {};
        const master = {
          gain:              (masterProps.faderGain ?? 0) / 100,
          balance:           0,
          followFadeToBlack: masterProps.followFadeToBlack ?? false,
        };
        return { channels, master };
      }
      // Fairlight inputs exist but sources not yet populated — fall through to classic
    }

    // Classic audio path (older firmware)
    if (!this._state?.audio) return null;
    const audio = this._state.audio;

    const channels = {};
    if (audio.channels) {
      for (const [idx, ch] of Object.entries(audio.channels)) {
        channels[idx] = {
          gain:      ch.gain      ?? 0,
          balance:   ch.balance   ?? 0,
          mixOption: ch.mixOption ?? 0,
          label:     this._getChannelLabel(Number(idx)),
        };
      }
    }

    const master = audio.master
      ? {
          gain:              audio.master.gain             ?? 0,
          balance:           audio.master.balance          ?? 0,
          followFadeToBlack: audio.master.followFadeToBlack ?? false,
        }
      : { gain: 0, balance: 0, followFadeToBlack: false };

    return { channels, master };
  }

  _buildLevels() {
    const audio = this._state?.audio;
    if (!audio?.levels) return null;

    const result = {};
    if (audio.levels.channels) {
      for (const [idx, ch] of Object.entries(audio.levels.channels)) {
        result[idx] = {
          left: ch.left ?? -60,
          right: ch.right ?? -60,
          peakLeft: ch.peakLeft ?? -60,
          peakRight: ch.peakRight ?? -60,
        };
      }
    }
    if (audio.levels.master) {
      result.master = {
        left: audio.levels.master.left ?? -60,
        right: audio.levels.master.right ?? -60,
        peakLeft: audio.levels.master.peakLeft ?? -60,
        peakRight: audio.levels.master.peakRight ?? -60,
      };
    }
    return result;
  }

  _getChannelLabel(idx) {
    // Prefer actual input name set in ATEM Software Control (e.g. "Cam 1", "Laptop")
    const shortName = this._state?.inputs?.[idx]?.shortName?.trim();
    if (shortName) return shortName;

    // Fallback: physical connector labels (for MIC/XLR which have no settings.inputs entry)
    const labels = {
      1: 'HDMI 1', 2: 'HDMI 2', 3: 'HDMI 3', 4: 'HDMI 4',
      5: 'HDMI 5', 6: 'HDMI 6', 7: 'HDMI 7', 8: 'HDMI 8',
      1301: 'MIC 1', 1302: 'MIC 2',
      2001: 'XLR 1', 2002: 'XLR 2',
    };
    return labels[idx] || `CH ${idx}`;
  }

  // ── ATEM Commands ──────────────────────────────────────────

  async setChannelGain(index, gainDb) {
    if (!this._isConnected()) return;
    if (this._isFairlight()) {
      const src = this._getFairlightSourceKey(index);
      if (src !== null)
        await this._atem.setFairlightAudioMixerSourceProps(index, BigInt(src), { faderGain: Math.round(gainDb * 100) });
    } else {
      await this._atem.setClassicAudioMixerInputProps(index, { gain: gainDb });
    }
  }

  async setChannelMixOption(index, mixOption) {
    if (!this._isConnected()) return;
    if (this._isFairlight()) {
      const src = this._getFairlightSourceKey(index);
      if (src !== null)
        await this._atem.setFairlightAudioMixerSourceProps(index, BigInt(src), { mixOption });
    } else {
      await this._atem.setClassicAudioMixerInputProps(index, { mixOption });
    }
  }

  async setChannelBalance(index, balance) {
    if (!this._isConnected()) return;
    if (this._isFairlight()) {
      const src = this._getFairlightSourceKey(index);
      if (src !== null)
        await this._atem.setFairlightAudioMixerSourceProps(index, BigInt(src), { balance: Math.round(balance * 200) });
    } else {
      await this._atem.setClassicAudioMixerInputProps(index, { balance });
    }
  }

  async setMasterGain(gainDb) {
    if (!this._isConnected()) return;
    if (this._isFairlight()) {
      await this._atem.setFairlightAudioMixerMasterProps({ faderGain: Math.round(gainDb * 100) });
    } else {
      await this._atem.setClassicAudioMixerMasterProps({ gain: gainDb });
    }
  }

  async setMasterBalance(balance) {
    if (!this._isConnected()) return;
    if (!this._isFairlight()) {
      // Fairlight master has no balance — only send for classic audio
      await this._atem.setClassicAudioMixerMasterProps({ balance });
    }
  }

  // ── Video Switcher Commands ─────────────────────────────────

  async setPreviewInput(source) {
    if (!this._isConnected()) return;
    await this._atem.changePreviewInput(0, source);
  }

  async setProgramInput(source) {
    if (!this._isConnected()) return;
    await this._atem.changeProgramInput(0, source);
  }

  async performAuto() {
    if (!this._isConnected()) return;
    await this._atem.autoTransition(0);
  }

  async performCut() {
    if (!this._isConnected()) return;
    await this._atem.cut(0);
  }

  async setTransitionStyle(style) {
    if (!this._isConnected()) return;
    await this._atem.setTransitionStyle(0, { style });
  }

  async setTransitionPosition(position) {
    // position: 0–9999 (0 = start, 9999 = end)
    if (!this._isConnected()) return;
    await this._atem.setMixEffectTransitionPosition(0, position);
  }

  async performFadeToBlack() {
    if (!this._isConnected()) return;
    await this._atem.fadeToBlack(0);
  }

  // ── Downstream Keyer Commands ───────────────────────────────

  async setDSKOnAir(keyerIndex, onAir) {
    if (!this._isConnected()) return;
    await this._atem.setDownstreamKeyerOnAir(keyerIndex, onAir);
  }

  async autoDSKTransition(keyerIndex) {
    if (!this._isConnected()) return;
    await this._atem.autoDownstreamKey(keyerIndex);
  }

  // ── Media Player Commands ───────────────────────────────────

  async setMediaPlayerStill(playerIndex, stillIndex) {
    if (!this._isConnected()) return;
    // playerIndex: 0=MP1, 1=MP2 | stillIndex: 0-based slot
    await this._atem.setMediaPlayerSource(playerIndex, { sourceType: 1, stillIndex });
  }

  // ── Video State Builder ─────────────────────────────────────

  _buildVideoState() {
    if (!this._state?.video) return null;
    const me = this._state.video.mixEffects?.[0];
    if (!me) return null;

    // Downstream keyers (DSK1 = index 0, DSK2 = index 1)
    const dsk = [0, 1].map(i => {
      const d = this._state.video.downstreamKeyers?.[i];
      return {
        onAir:        d?.onAir                  ?? false,
        inTransition: d?.inTransition            ?? false,
        autoRate:     d?.properties?.rate        ?? 25,
        fillSource:   d?.sources?.fillSource     ?? 0,
        cutSource:    d?.sources?.cutSource      ?? 0,
      };
    });

    return {
      programInput:         me.programInput                       ?? 0,
      previewInput:         me.previewInput                       ?? 0,
      transitionStyle:      me.transitionProperties?.style        ?? 0,
      transitionInProgress: me.transitionPosition?.inTransition   ?? false,
      transitionPosition:   me.transitionPosition?.handlePosition ?? 0,
      fadeToBlack: {
        isFullyBlack: me.fadeToBlack?.isFullyBlack ?? false,
        inTransition: me.fadeToBlack?.inTransition ?? false,
      },
      dsk,
      inputLabels: this._buildVideoInputLabels(),
    };
  }

  _buildVideoInputLabels() {
    const sources = { 1: 'CH 1', 2: 'CH 2', 3: 'CH 3', 4: 'CH 4', 3010: 'MP 1', 3020: 'MP 2', 0: 'BLK' };
    const labels = {};
    for (const [id, fallback] of Object.entries(sources)) {
      const shortName = this._state?.inputs?.[Number(id)]?.shortName?.trim();
      labels[id] = shortName || fallback;
    }
    return labels;
  }

  // ── Media State Builder ─────────────────────────────────────

  _buildMediaState() {
    if (!this._state?.media) return null;
    const media = this._state.media;

    const players = {};
    if (media.players) {
      for (const [idx, player] of Object.entries(media.players)) {
        players[idx] = {
          sourceType: player.sourceType ?? 1,
          stillIndex: player.stillIndex ?? 0,
          playing:    player.playing   ?? false,
          loop:       player.loop      ?? false,
        };
      }
    }

    const stillPool = {};
    if (media.stillPool) {
      for (const [idx, still] of Object.entries(media.stillPool)) {
        stillPool[idx] = {
          isUsed:   still.isUsed   ?? false,
          fileName: still.fileName ?? '',
        };
      }
    }

    return { players, stillPool };
  }

  _isConnected() {
    return this._status === 'connected' && this._atem !== null;
  }
}

module.exports = new AtemManager();
