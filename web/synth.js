// Small Web Audio synth for auditioning the board's MIDI output in the page.
// Built from the browser's own audio nodes, so it works from file:// with no
// extra files. Per voice: two oscillators -> low-pass filter -> amplifier.
//   CC 1  vibrato depth      CC 7   volume
//   CC 74 brightness         CC 120/123  all notes off
//   pitch bend +/- 2 semitones
// Plus a tempo-synced echo (delay) after the voices.
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
      this.sound = 'warm';
      this.voices = new Map();  // "ch:note" -> voice
      this.order = [];          // voice keys, oldest first
      this.cc = { 1: 0, 7: 100, 74: 64 };
      this.bend = 0;            // -1..1
      this.volume = 0.8;        // page volume control, 0..1
      this.tempo = 120;         // BPM, for the echo
      // Echo: beats between repeats (0 = off), feedback 0..0.85, level 0..1.
      this.echo = { beats: 0, feedback: 0.4, level: 0.35 };
      if (ctx) this._build();
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
      // One vibrato LFO shared by all voices, feeding their detune.
      this.lfo = c.createOscillator();
      this.lfo.frequency.value = 5.5;
      this.lfoDepth = c.createGain();
      this.lfoDepth.gain.value = 0;
      this.lfo.connect(this.lfoDepth);
      this.lfo.start();

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

    setSound(id) {
      if (SOUNDS[id]) this.sound = id;
    }

    setVolume(v) {
      this.volume = v;
      if (this.ctx) this._applyVolume();
    }

    _applyVolume() {
      const cc7 = this.cc[7] / 127;
      this.master.gain.setTargetAtTime(this.volume * cc7 * cc7, this.ctx.currentTime, 0.02);
    }

    _cutoff(note, sound) {
      // CC 74 sweeps about 150 Hz to 15 kHz; higher notes are a little brighter.
      const base = 150 * Math.pow(2, (this.cc[74] / 127) * 6.6) * sound.cutoffScale;
      return Math.min(18000, base * Math.pow(2, (note - 60) / 48));
    }

    // Feeds one MIDI message (array or Uint8Array).
    handleMidi(d) {
      if (!this.ctx) return;
      const type = d[0] & 0xf0;
      const ch = d[0] & 0x0f;
      if (type === 0x90 && d[2] > 0) this.noteOn(ch, d[1], d[2]);
      else if (type === 0x80 || type === 0x90) this.noteOff(ch, d[1]);
      else if (type === 0xb0) this.controller(d[1], d[2]);
      else if (type === 0xe0) this.pitchBend(((d[2] << 7) | d[1]) / 8192 - 1);
    }

    noteOn(ch, note, vel) {
      const key = `${ch}:${note}`;
      if (this.voices.has(key)) this._release(key, 0.01);
      if (this.voices.size >= MAX_VOICES) this._release(this.order[0], 0.01);

      const c = this.ctx;
      const s = SOUNDS[this.sound];
      const t = c.currentTime;
      const amp = c.createGain();
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = s.q;
      const cutoff = this._cutoff(note, s);
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
        o.detune.value = this.bend * BEND_CENTS + (i ? s.detune : -s.detune);
        this.lfoDepth.connect(o.detune);
        o.connect(filter);
        o.start(t);
        return o;
      });
      filter.connect(amp).connect(this.master);

      this.voices.set(key, { oscs, filter, amp, note, sound: s, detunes: oscs.map((o) => o.detune.value - this.bend * BEND_CENTS) });
      this.order.push(key);
    }

    noteOff(ch, note) {
      const key = `${ch}:${note}`;
      if (this.voices.has(key)) this._release(key);
    }

    _release(key, time = null) {
      const v = this.voices.get(key);
      if (!v) return;
      this.voices.delete(key);
      this.order = this.order.filter((k) => k !== key);
      const t = this.ctx.currentTime;
      const r = time ?? v.sound.release;
      v.amp.gain.cancelScheduledValues(t);
      v.amp.gain.setValueAtTime(v.amp.gain.value, t);
      v.amp.gain.setTargetAtTime(0, t, r / 4);
      for (const o of v.oscs) {
        o.stop(t + r + 0.05);
        o.onended = () => {
          o.disconnect();
          v.filter.disconnect();
          v.amp.disconnect();
        };
      }
    }

    controller(cc, value) {
      if (cc === 120 || cc === 123) return this.allNotesOff();
      if (!(cc in this.cc)) return;
      this.cc[cc] = value;
      const t = this.ctx.currentTime;
      if (cc === 1) this.lfoDepth.gain.setTargetAtTime((value / 127) * VIBRATO_MAX_CENTS, t, 0.02);
      if (cc === 7) this._applyVolume();
      if (cc === 74)
        for (const v of this.voices.values())
          v.filter.frequency.setTargetAtTime(this._cutoff(v.note, v.sound), t, 0.02);
    }

    pitchBend(amount) {
      this.bend = amount;
      const t = this.ctx.currentTime;
      for (const v of this.voices.values())
        v.oscs.forEach((o, i) => o.detune.setTargetAtTime(v.detunes[i] + amount * BEND_CENTS, t, 0.01));
    }

    allNotesOff() {
      for (const key of [...this.voices.keys()]) this._release(key, 0.02);
    }

    get activeVoices() {
      return this.voices.size;
    }
  }

  global.SwitchcraftSynth = { Synth, SOUNDS, MAX_VOICES };
})(typeof window !== 'undefined' ? window : globalThis);
