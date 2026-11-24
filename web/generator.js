// generator.js: the note generator of spec B.6.3 (proposed for firmware
// 0.8.0), in JavaScript, so it can be heard in the browser before it's
// written in C. Each call to newNote() chooses a scale degree by a weighted
// random walk from the last one, with gap fill, accents on stable notes,
// cadences at phrase ends and an optional remembered tune that changes a
// little each time round. Degrees are turned into MIDI notes by the caller
// (Switchcraft.degreeToNote), exactly as the firmware does for NOTE.
// A classic script like switchcraft.js.
(function (global) {
  'use strict';

  // The spec's fields, with the page's "wander" defaults (B.6.3).
  function defaults() {
    return {
      gapFill: true,
      low: -2, high: 7, home: 0, maxLeap: 4,
      wRepeat: 10, wStep: 60, wSkip: 20, wLeap: 10,
      stableMask: 0x0081,   // root and fifth
      accentEvery: 4,
      stableBoost: 30,      // tenths: 3.0x
      phraseLen: 8,
      loopLen: 8,
      change: 15,           // %
    };
  }

  // Semitones above the root of each degree in one octave of the scale.
  function scaleSemis(mask) {
    const out = [];
    for (let s = 0; s < 12; s++) if (mask & (1 << s)) out.push(s);
    return out;
  }

  class Generator {
    // scaleMask: the template's scale (spec B.3). rng: () => [0, 1).
    constructor(settings = {}, scaleMask = 0x0295, rng = Math.random) {
      this.s = { ...defaults(), ...settings };
      this.mask = scaleMask;
      this.rng = rng;
      this.reset();
    }

    set(settings) {
      const loopLen = this.s.loopLen;
      Object.assign(this.s, settings);
      // A new tune length starts the tune again; keep the walk going.
      if (this.s.loopLen !== loopLen) { this.loop = Array(this.s.loopLen).fill(null); this.loopPos = 0; }
      if (this.s.phraseLen > 0) this.phrasePos %= this.s.phraseLen; else this.phrasePos = 0;
    }

    setScale(mask) { this.mask = mask; }

    // GEN_NEW: forget everything; the next note starts from home.
    reset() {
      this.last = null;
      this.lastMove = 0;
      this.phrasePos = 0;
      this.loop = Array(this.s.loopLen).fill(null);
      this.loopPos = 0;
    }

    inRange(d) { return d >= this.s.low && d <= this.s.high; }
    octave() { return scaleSemis(this.mask).length; }
    isStable(d) {
      const semis = scaleSemis(this.mask);
      const n = semis.length;
      const idx = ((d % n) + n) % n;
      return !!(this.s.stableMask & (1 << semis[idx]));
    }

    // Step 1: the home degree (plus whole octaves) nearest p and in range,
    // the lower one on a tie; home itself if none is.
    cadenceFrom(p) {
      const oct = this.octave();
      let best = null;
      for (let d = this.s.home - 10 * oct; d <= this.s.home + 10 * oct; d += oct) {
        if (!this.inRange(d)) continue;
        if (best === null || Math.abs(d - p) < Math.abs(best - p)) best = d;
      }
      return best === null ? this.s.home : best;
    }

    // Steps 1-5 of "Choosing a new note". Returns {degree, why}.
    choose() {
      const s = this.s;
      const p = this.last === null ? s.home : this.last;
      const m = this.lastMove;
      // 1. Cadence: a phrase always ends at home, even straight after a jump.
      if (s.phraseLen > 0 && this.phrasePos === s.phraseLen - 1)
        return { degree: this.cadenceFrom(p), why: 'cadence' };
      // 2. Gap fill.
      if (s.gapFill && Math.abs(m) >= 2 && this.inRange(p - Math.sign(m)))
        return { degree: p - Math.sign(m), why: 'gap fill' };
      // 3. Candidates.
      const cands = [[p, s.wRepeat, 'repeat']];
      for (const dir of [-1, 1]) {
        cands.push([p + dir, s.wStep, 'step'], [p + 2 * dir, s.wSkip, 'skip']);
        const leaps = s.maxLeap - 2;
        for (let k = 3; k <= s.maxLeap; k++) cands.push([p + k * dir, s.wLeap / leaps, 'leap']);
      }
      let options = cands.filter(([d]) => this.inRange(d));
      // 4. Accent.
      const accent = s.accentEvery > 0 && this.phrasePos % s.accentEvery === 0;
      if (accent) options = options.map(([d, w, why]) => [d, this.isStable(d) ? w * s.stableBoost / 10 : w, why]);
      // 5. Pick.
      const total = options.reduce((t, [, w]) => t + w, 0);
      if (total <= 0) return { degree: s.home, why: 'home (nothing in range)' };
      let r = this.rng() * total;
      for (const [d, w, why] of options) {
        if ((r -= w) < 0) return { degree: d, why: accent ? `${why}, accent` : why };
      }
      const [d, , why] = options[options.length - 1];
      return { degree: d, why };
    }

    played(d) {
      this.lastMove = this.last === null ? 0 : d - this.last;
      this.last = d;
    }

    // GEN_NOTE. Returns {degree, why, loopPos (the position played, or null), fresh}.
    newNote() {
      const s = this.s;
      let result, fresh = true, pos = null;
      if (s.loopLen > 0) {
        pos = this.loopPos;
        const stored = this.loop[pos];
        if (stored === null || this.rng() * 100 < s.change) {
          result = this.choose();
          if (stored !== null) result.why = `changed: ${result.why}`;
          this.loop[pos] = result.degree;
        } else {
          result = { degree: stored, why: 'remembered' };
          fresh = false;
        }
        this.loopPos = (pos + 1) % s.loopLen;
      } else {
        result = this.choose();
      }
      this.played(result.degree);
      if (s.phraseLen > 0) this.phrasePos = (this.phrasePos + 1) % s.phraseLen;
      return { ...result, loopPos: pos, fresh };
    }

    // GEN_HOME: the cadence note now, then the phrase and the tune start again.
    home() {
      const d = this.cadenceFrom(this.last === null ? this.s.home : this.last);
      this.played(d);
      this.phrasePos = 0;
      this.loopPos = 0;
      return { degree: d, why: 'home', loopPos: null, fresh: false };
    }

    // GEN_AGAIN: the last note again; nothing moves on.
    again() {
      return { degree: this.last === null ? this.s.home : this.last, why: 'again', loopPos: null, fresh: false };
    }
  }

  // "Moves: mostly steps <-> lots of leaps" (0-100) as the four weights.
  function movesToWeights(t) {
    const a = [10, 70, 15, 5], b = [5, 30, 30, 35];
    const [wRepeat, wStep, wSkip, wLeap] = a.map((v, i) => Math.round(v + (b[i] - v) * t / 100));
    return { wRepeat, wStep, wSkip, wLeap };
  }

  global.SwitchcraftGenerator = { Generator, defaults, movesToWeights, scaleSemis };
})(typeof window !== 'undefined' ? window : globalThis);
