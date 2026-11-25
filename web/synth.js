// Small Web Audio synth for auditioning the board's MIDI output in the page.
// Built from the browser's own audio nodes, so it works from file:// with no
// extra files.
//
// Four parts, each listening on a MIDI channel: three voices (two
// oscillators -> low-pass filter -> amplifier per note) and a drum kit
// (General MIDI drum notes, made from tones and noise). A device plays a part
// by sending on its channel; channels no part listens on are silent.
//   CC 1  vibrato depth      CC 7   volume   channel pressure: vibrato too
//   CC 74 brightness         CC 120/123  all notes off
//   pitch bend +/- 2 semitones
// (each per channel). Plus a tempo-synced echo (delay) after the parts.
// A classic script (not a module) like switchcraft.js.

(function (global) {
  'use strict';

  const SOUNDS = {
    warm: { name: 'Warm', waves: ['sawtooth', 'triangle'], detune: 6, cutoffScale: 0.6, q: 2,
      attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.3, envAmount: 2 },
    bright: { name: 'Bright', waves: ['sawtooth', 'sawtooth'], detune: 9, cutoffScale: 1, q: 4,
      attack: 0.005, decay: 0.25, sustain: 0.5, release: 0.25, envAmount: 3 },
    soft: { name: 'Soft', waves: ['triangle', 'sine'], detune: 4, cutoffScale: 0.8, q: 0.7,
      attack: 0.04, decay: 0.4, sustain: 0.7, release: 0.5, envAmount: 1 },
    pluck: { name: 'Pluck', waves: ['square', 'sawtooth'], detune: 5, cutoffScale: 0.7, q: 3,
      attack: 0.002, decay: 0.35, sustain: 0, release: 0.2, envAmount: 4 },
    bass: { name: 'Bass', waves: ['sawtooth', 'square'], detune: 3, cutoffScale: 0.35, q: 5,
      attack: 0.005, decay: 0.2, sustain: 0.5, release: 0.15, envAmount: 3 },
    keys: { name: 'Keys', waves: ['triangle', 'sine'], detune: 3, cutoffScale: 0.9, q: 1,
      attack: 0.003, decay: 0.9, sustain: 0.15, release: 0.4, envAmount: 2.5 },
    organ: { name: 'Organ', waves: ['square', 'sine'], detune: 1, cutoffScale: 0.9, q: 0.5,
      attack: 0.01, decay: 0.1, sustain: 1, release: 0.08, envAmount: 1 },
    strings: { name: 'Strings', waves: ['sawtooth', 'sawtooth'], detune: 14, cutoffScale: 0.45, q: 0.8,
      attack: 0.35, decay: 0.6, sustain: 0.85, release: 0.9, envAmount: 1.3 },
    brass: { name: 'Brass', waves: ['sawtooth', 'sawtooth'], detune: 7, cutoffScale: 0.4, q: 2,
      attack: 0.06, decay: 0.3, sustain: 0.8, release: 0.2, envAmount: 3.5 },
    lead: { name: 'Lead', waves: ['square', 'sawtooth'], detune: 10, cutoffScale: 1, q: 6,
      attack: 0.005, decay: 0.2, sustain: 0.8, release: 0.15, envAmount: 2 },
    chip: { name: 'Chip', waves: ['square', 'square'], detune: 0, cutoffScale: 3, q: 0.3,
      attack: 0.001, decay: 0.05, sustain: 0.9, release: 0.03, envAmount: 1 },
  };

  // The parts and the channel (0-15) each listens on, to start with.
  const PARTS = [
    { name: 'Voice 1', channel: 0, sound: 'warm', volume: 0.8 },
    { name: 'Voice 2', channel: 1, sound: 'pluck', volume: 0.8 },
    { name: 'Voice 3', channel: 2, sound: 'bass', volume: 0.8 },
    { name: 'Drums', channel: 9, sound: null, volume: 0.8, drums: true },
  ];

  // General MIDI drums: [kind, pitch]. Others play a short blip.
  const KIT = {
    35: ['kick'], 36: ['kick'], 37: ['click', 1700], 38: ['snare'], 39: ['clap'], 40: ['snare'],
    41: ['tom', 75], 42: ['hat', 0.05], 43: ['tom', 90], 44: ['hat', 0.04], 45: ['tom', 105], 46: ['hat', 0.4],
    47: ['tom', 125], 48: ['tom', 145], 49: ['cymbal', 1.3], 50: ['tom', 170], 51: ['cymbal', 0.7],
    52: ['cymbal', 1.0], 53: ['cymbal', 0.5], 54: ['shaker', 0.15], 55: ['cymbal', 0.8], 56: ['cowbell'],
    57: ['cymbal', 1.3], 59: ['cymbal', 0.7], 60: ['tom', 330], 61: ['tom', 260], 62: ['tom', 220],
    63: ['tom', 200], 64: ['tom', 160], 69: ['shaker', 0.1], 70: ['shaker', 0.08], 75: ['click', 2500],
    76: ['click', 1000], 77: ['click', 800],
  };

  const MAX_VOICES = 16;
  const BEND_CENTS = 200;
  const VIBRATO_MAX_CENTS = 40;

  const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

  class Synth {
    // ctx: an AudioContext (or OfflineAudioContext in tests). If omitted,
    // one is created by start(), which must run from a click.
    constructor(ctx = null) {
      this.ctx = ctx;
      this.parts = PARTS.map((p) => ({ ...p, cc: { 1: 0, 7: 100, 74: 64 }, bend: 0, pressure: 0 }));
      this.voices = new Map();  // "part:note" -> voice
      this.order = [];          // voice keys, oldest first
      this.volume = 0.8;        // page volume control, 0..1
      this.tempo = 120;         // BPM, for the echo
      // Echo: beats between repeats (0 = off), feedback 0..0.85, level 0..1.
      this.echo = { beats: 0, feedback: 0.4, level: 0.35 };
      if (ctx) this._build();
    }

    // The first part's sound (the page used to have just one).
    get sound() {
      return this.parts[0].sound;
    }

    async start() {
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this._build();
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    }

    async stop() {
      this.allNotesOff();
      if (this.ctx && this.ctx.state === 'running' && this.ctx.suspend) await this.ctx.suspend();
    }

    get running() {
      return !!this.ctx && this.ctx.state === 'running';
    }

    _build() {
      const c = this.ctx;
      this.master = c.createGain();
      this.limiter = c.createDynamicsCompressor();
      this.limiter.threshold.value = -10;
      this.limiter.ratio.value = 12;
      this.master.connect(this.limiter).connect(c.destination);
      // One vibrato LFO, with a depth for each part, feeding its notes' detune.
      this.lfo = c.createOscillator();
      this.lfo.frequency.value = 5.5;
      this.lfo.start();
      for (const p of this.parts) {
        p.out = c.createGain();
        p.out.connect(this.master);
        p.lfoDepth = c.createGain();
        p.lfoDepth.gain.value = 0;
        this.lfo.connect(p.lfoDepth);
        this._applyPartVolume(p, true);
      }
      // Two seconds of white noise, for the drums.
      this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      // Echo: master -> delay -> (filter -> feedback -> delay) and -> wet -> limiter.
      // The filter in the loop makes each repeat a little darker.
      this.delay = c.createDelay(2);
      this.delayTone = c.createBiquadFilter();
      this.delayTone.type = 'lowpass';
      this.delayTone.frequency.value = 3500;
      this.feedback = c.createGain();
      this.wet = c.createGain();
      this.master.connect(this.delay);
      this.delay.connect(this.delayTone).connect(this.feedback).connect(this.delay);
      this.delay.connect(this.wet).connect(this.limiter);

      this._applyVolume();
      this._applyEcho(true);
    }

    setTempo(bpm) {
      this.tempo = bpm;
      if (this.ctx) this._applyEcho();
    }

    setEcho({ beats = this.echo.beats, feedback = this.echo.feedback, level = this.echo.level } = {}) {
      this.echo = { beats, feedback: Math.min(0.85, Math.max(0, feedback)), level };
      if (this.ctx) this._applyEcho();
    }

    // Changes glide (no clicks); `now` sets the values straight away.
    _applyEcho(now = false) {
      const t = this.ctx.currentTime;
      const on = this.echo.beats > 0;
      const set = (param, value, tau) =>
        (now ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, tau));
      set(this.delay.delayTime, Math.min(2, (60 / this.tempo) * (this.echo.beats || 0.5)), 0.05);
      set(this.feedback.gain, on ? this.echo.feedback : 0, 0.02);
      set(this.wet.gain, on ? this.echo.level : 0, 0.02);
    }

    // The first voice's sound.
    setSound(id) {
      this.setPart(0, { sound: id });
    }

    // A part's channel (0-15), sound or volume (0..1).
    setPart(i, { channel, sound, volume } = {}) {
      const p = this.parts[i];
      if (!p) return;
      if (channel !== undefined && channel !== p.channel) {
        this._releasePart(i);
        p.channel = channel;
      }
      if (sound !== undefined && !p.drums && SOUNDS[sound]) p.sound = sound;
      if (volume !== undefined) {
        p.volume = volume;
        if (this.ctx) this._applyPartVolume(p);
      }
    }

    // The parts listening on a channel.
    partsOn(ch) {
      return this.parts.filter((p) => p.channel === ch);
    }

    setVolume(v) {
      this.volume = v;
      if (this.ctx) this._applyVolume();
    }

    _applyVolume() {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }

    _applyPartVolume(p, now = false) {
      const cc7 = p.cc[7] / 127;
      const v = p.volume * cc7 * cc7;
      if (now) p.out.gain.setValueAtTime(v, this.ctx.currentTime);
      else p.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    _cutoff(p, note, sound) {
      // CC 74 sweeps about 150 Hz to 15 kHz; higher notes are a little brighter.
      const base = 150 * Math.pow(2, (p.cc[74] / 127) * 6.6) * sound.cutoffScale;
      return Math.min(18000, base * Math.pow(2, (note - 60) / 48));
    }

    // Feeds one MIDI message (array or Uint8Array).
    handleMidi(d) {
      if (!this.ctx) return;
      const type = d[0] & 0xf0;
      const ch = d[0] & 0x0f;
      if (type === 0x90 && d[2] > 0) this.noteOn(ch, d[1], d[2]);
      else if (type === 0x80 || type === 0x90) this.noteOff(ch, d[1]);
      else if (type === 0xb0) this.controller(d[1], d[2], ch);
      else if (type === 0xe0) this.pitchBend(((d[2] << 7) | d[1]) / 8192 - 1, ch);
      else if (type === 0xd0) this.channelPressure(d[1], ch);
    }

    noteOn(ch, note, vel) {
      for (const p of this.partsOn(ch)) this._partNoteOn(this.parts.indexOf(p), note, vel);
    }

    // A short, quiet note on the first voice: the page plays it when the
    // synth comes on, so you can tell it works before playing the board.
    blip() {
      this._partNoteOn(0, 84, 40);
      setTimeout(() => this._release('0:84'), 120);
    }

    _partNoteOn(i, note, vel) {
      const p = this.parts[i];
      const key = `${i}:${note}`;
      if (this.voices.has(key)) this._release(key, 0.01);
      if (this.voices.size >= MAX_VOICES) this._release(this.order[0], 0.01);
      const v = p.drums ? this._drum(p, note, vel) : this._tone(p, note, vel);
      v.key = key;
      this.voices.set(key, v);
      this.order.push(key);
      // A drum ends by itself, when its longest sound does.
      if (p.drums) v.last.onended = () => this._forget(key, v);
    }

    _tone(p, note, vel) {
      const c = this.ctx;
      const s = SOUNDS[p.sound];
      const t = c.currentTime;
      const amp = c.createGain();
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = s.q;
      const cutoff = this._cutoff(p, note, s);
      // Filter envelope: opens above the CC 74 level, then settles back.
      filter.frequency.setValueAtTime(cutoff, t);
      filter.frequency.linearRampToValueAtTime(Math.min(18000, cutoff * s.envAmount), t + s.attack);
      filter.frequency.setTargetAtTime(cutoff, t + s.attack, s.decay / 3);

      const peak = 0.25 * Math.pow(vel / 127, 1.5);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + s.attack);
      amp.gain.setTargetAtTime(peak * s.sustain, t + s.attack, s.decay / 3);

      const oscs = s.waves.map((wave, i) => {
        const o = c.createOscillator();
        o.type = wave;
        o.frequency.value = mtof(note);
        o.detune.value = p.bend * BEND_CENTS + (i ? s.detune : -s.detune);
        p.lfoDepth.connect(o.detune);
        o.connect(filter);
        o.start(t);
        return o;
      });
      filter.connect(amp).connect(p.out);
      return { part: p, sources: oscs, nodes: [filter, amp], filter, amp, note, release: s.release, sound: s,
        detunes: oscs.map((o) => o.detune.value - p.bend * BEND_CENTS) };
    }

    // One drum hit: tones and noise, each with its own fall, into one amp.
    _drum(p, note, vel) {
      const c = this.ctx;
      const t = c.currentTime;
      const [kind, x] = KIT[note] || ['blip'];
      const amp = c.createGain();
      amp.gain.value = 0.5 * Math.pow(vel / 127, 1.3);
      amp.connect(p.out);
      const sources = [];
      const nodes = [amp];
      let end = -1;
      let last = null;  // the sound that ends last
      // A tone gliding from f0 to f1, falling away over `decay` seconds.
      const tone = (type, f0, f1, glide, decay, level) => {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f1, t + glide);
        g.gain.setValueAtTime(level, t);
        g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
        o.connect(g).connect(amp);
        o.start(t);
        o.stop(t + decay + 0.02);
        sources.push(o);
        nodes.push(g);
        if (decay > end) [end, last] = [decay, o];
      };
      // Noise through a filter, falling away over `decay` seconds.
      const noise = (type, freq, q, decay, level, delay = 0) => {
        const n = c.createBufferSource();
        n.buffer = this.noise;
        const f = c.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        const g = c.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.setValueAtTime(level, t + delay);
        g.gain.exponentialRampToValueAtTime(0.0005, t + delay + decay);
        n.connect(f).connect(g).connect(amp);
        n.start(t);
        n.stop(t + delay + decay + 0.02);
        sources.push(n);
        nodes.push(f, g);
        if (delay + decay > end) [end, last] = [delay + decay, n];
      };
      switch (kind) {
        case 'kick': tone('sine', 160, 45, 0.12, 0.45, 1); tone('triangle', 400, 60, 0.02, 0.03, 0.4); break;
        case 'snare': tone('triangle', 190, 160, 0.05, 0.12, 0.6); noise('highpass', 1200, 0.7, 0.2, 0.9); break;
        case 'clap':
          noise('bandpass', 1200, 1.2, 0.03, 0.9, 0); noise('bandpass', 1200, 1.2, 0.03, 0.9, 0.012);
          noise('bandpass', 1200, 1.2, 0.18, 0.9, 0.024); break;
        case 'hat': noise('highpass', 7500, 0.8, x, 0.6); break;
        case 'cymbal': noise('highpass', 5500, 0.6, x, 0.5); noise('bandpass', 9000, 1.5, x * 0.6, 0.3); break;
        case 'shaker': noise('highpass', 8500, 0.7, x, 0.4); break;
        case 'tom': tone('sine', x * 1.6, x, 0.08, 0.35, 0.9); break;
        case 'click': tone('triangle', x, x, 0.01, 0.05, 0.7); break;
        case 'cowbell':
          tone('square', 560, 560, 0.01, 0.3, 0.25); tone('square', 845, 845, 0.01, 0.3, 0.25); break;
        default: tone('sine', mtof(note), mtof(note), 0.01, 0.15, 0.5);
      }
      return { part: p, sources, nodes, amp, note, release: 0.05, drum: true, last };
    }

    noteOff(ch, note) {
      for (const p of this.partsOn(ch)) {
        if (p.drums) continue;  // drums ring out by themselves
        const key = `${this.parts.indexOf(p)}:${note}`;
        if (this.voices.has(key)) this._release(key);
      }
    }

    _forget(key, v) {
      if (this.voices.get(key) === v) {
        this.voices.delete(key);
        this.order = this.order.filter((k) => k !== key);
      }
      for (const n of [...v.sources, ...v.nodes]) n.disconnect();
    }

    _release(key, time = null) {
      const v = this.voices.get(key);
      if (!v) return;
      this.voices.delete(key);
      this.order = this.order.filter((k) => k !== key);
      const t = this.ctx.currentTime;
      const r = time ?? v.release;
      v.amp.gain.cancelScheduledValues(t);
      v.amp.gain.setValueAtTime(v.amp.gain.value, t);
      v.amp.gain.setTargetAtTime(0, t, r / 4);
      for (const o of v.sources) {
        try {
          o.stop(t + r + 0.05);
        } catch (e) { /* already stopped */ }
        o.onended = () => {
          for (const n of [...v.sources, ...v.nodes]) n.disconnect();
        };
      }
    }

    _releasePart(i) {
      for (const key of [...this.voices.keys()]) if (key.startsWith(`${i}:`)) this._release(key, 0.02);
    }

    // A controller on a channel (all channels if none is given).
    controller(cc, value, ch = null) {
      if (cc === 120 || cc === 123) {
        if (ch === null) return this.allNotesOff();
        for (const p of this.partsOn(ch)) this._releasePart(this.parts.indexOf(p));
        return;
      }
      for (const p of ch === null ? this.parts : this.partsOn(ch)) {
        if (!(cc in p.cc)) continue;
        p.cc[cc] = value;
        const t = this.ctx.currentTime;
        if (cc === 1) this._applyVibrato(p);
        if (cc === 7) this._applyPartVolume(p);
        if (cc === 74 && !p.drums)
          for (const v of this.voices.values())
            if (v.part === p) v.filter.frequency.setTargetAtTime(this._cutoff(p, v.note, v.sound), t, 0.02);
      }
    }

    channelPressure(value, ch = 0) {
      for (const p of this.partsOn(ch)) {
        p.pressure = value;
        this._applyVibrato(p);
      }
    }

    _applyVibrato(p) {
      const depth = Math.max(p.cc[1], p.pressure) / 127;
      p.lfoDepth.gain.setTargetAtTime(depth * VIBRATO_MAX_CENTS, this.ctx.currentTime, 0.02);
    }

    pitchBend(amount, ch = 0) {
      const t = this.ctx.currentTime;
      for (const p of this.partsOn(ch)) {
        if (p.drums) continue;
        p.bend = amount;
        for (const v of this.voices.values())
          if (v.part === p) v.sources.forEach((o, i) => o.detune.setTargetAtTime(v.detunes[i] + amount * BEND_CENTS, t, 0.01));
      }
    }

    allNotesOff() {
      for (const key of [...this.voices.keys()]) this._release(key, 0.02);
    }

    get activeVoices() {
      return this.voices.size;
    }
  }

  global.SwitchcraftSynth = { Synth, SOUNDS, PARTS, KIT, MAX_VOICES };
})(typeof window !== 'undefined' ? window : globalThis);
