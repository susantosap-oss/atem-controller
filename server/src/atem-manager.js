/**
 * ATEM Manager — wraps atem-connection library.
 * Handles connect/disconnect lifecycle, emits events to bridge.
 */
const { Atem } = require('atem-connection');
const { EventEmitter } = require('events');

class AtemManager extends EventEmitter {
  constructor() {
    super();
    this._atem = null;
    this._ip = null;
    this._status = 'disconnected'; // 'connecting' | 'connected' | 'disconnected' | 'error'
    this._reconnectTimer = null;
    this._state = null;
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
      this.emit('audioState', this._buildAudioState());
      const ms = this._buildMediaState();
      if (ms) this.emit('mediaState', ms);
      const vs = this._buildVideoState();
      if (vs) this.emit('videoState', vs);
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
    if (this._atem) {
      this._atem.removeAllListeners();
      try { await this._atem.disconnect(); } catch (_) {}
      this._atem = null;
    }
    if (clearIP) this._ip = null;
    this._state = null;
    this._setStatus('disconnected');
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    if (!this._ip) return;
    console.log('[ATEM] Reconnecting in 5s...');
    this._reconnectTimer = setTimeout(() => {
      if (this._status !== 'connected' && this._ip) {
        this.connect(this._ip);
      }
    }, 5000);
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
           k.startsWith('settings.inputs')
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

    // Emit video state when ME inputs/transition change
    const videoStatePaths = pathKeys.filter(k => k.startsWith('video'));
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
        channels[idx] = {
          gain:      (props.faderGain ?? 0) / 100,   // centidB → dB
          balance:   (props.balance  ?? 0) / 200,    // raw int16 → -50..+50
          mixOption: props.mixOption ?? 0,
          label:     this._getChannelLabel(Number(idx)),
        };
      }
      const masterProps = this._state.fairlight.master?.properties ?? {};
      const master = {
        gain:              (masterProps.faderGain ?? 0) / 100,
        balance:           0,
        followFadeToBlack: masterProps.followFadeToBlack ?? false,
      };
      return { channels, master };
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
    const shortName = this._state?.settings?.inputs?.[idx]?.shortName?.trim();
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
    const me = this._state.video.ME?.[0];
    if (!me) return null;

    // Downstream keyers (DSK1 = index 0, DSK2 = index 1)
    const dsk = [0, 1].map(i => {
      const d = this._state.video.downstreamKeyers?.[i];
      return {
        onAir:        d?.onAir        ?? false,
        inTransition: d?.inTransition ?? false,
        autoRate:     d?.autoRate     ?? 25,
        fillSource:   d?.sources?.fillSource ?? 0,
        cutSource:    d?.sources?.cutSource  ?? 0,
      };
    });

    return {
      programInput: me.programInput ?? 0,
      previewInput: me.previewInput ?? 0,
      transitionStyle: me.transitionSettings?.style ?? 0,
      transitionInProgress: me.transitionInProgress ?? false,
      transitionPosition: me.transitionPosition ?? 0,
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
      const shortName = this._state?.settings?.inputs?.[Number(id)]?.shortName?.trim();
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
