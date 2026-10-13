// Switchcraft protocol, rule-table format and board connection.
// Spec: docs/sysex-rule-table-spec.md. No UI code here (tested by test.html).
// A classic script (not a module) so the page also works from file://.

(function (global) {
  'use strict';

  // --- Protocol constants (spec part A) ---

  const HEADER = [0xf0, 0x7d, 0x53, 0x43];
  const PROTOCOL_VERSION = 1;
  const SOURCE_WORKING = 0xff;
  const CHUNK = 64;
  const NUM_INPUTS = 12;
  const NUM_ANALOG = 2;
  const NUM_SLOTS = 8;
  // Default analog calibration: Logitech Adaptive Gaming Kit variable
  // triggers (~3850 at rest, ~2250 fully pressed), so inverted.
  const DEFAULT_CALIBRATION = { min: [3750, 3750], max: [2350, 2350] };

  const CMD = {
    IDENTIFY: 0x01, TABLE_INFO: 0x02, TABLE_READ: 0x03, WRITE_BEGIN: 0x04,
    WRITE_DATA: 0x05, WRITE_COMMIT: 0x06, SLOT_SAVE: 0x07, SLOT_LOAD: 0x08,
    SLOT_ERASE: 0x09, ALL_NOTES_OFF: 0x0a, CALIBRATION_GET: 0x0b, CALIBRATION_SET: 0x0c,
  };
  const REPORT = { INPUT: 0x60, ANALOG: 0x61, SLOT: 0x62, CLOCK: 0x63 };
  const EVENTS = { 1: 'press', 2: 'release', 3: 'hold', 4: 'tap' };

  const STATUS = {
    0x00: 'OK', 0x01: 'unknown command', 0x02: 'bad length', 0x03: 'message too long',
    0x04: 'unsupported version', 0x05: 'out of sequence', 0x06: 'CRC mismatch',
    0x07: 'invalid table', 0x08: 'out of range', 0x09: 'slot is empty',
    0x0a: 'flash error', 0x0b: 'busy',
  };
  const INVALID = {
    1: 'header', 2: 'section bounds', 3: 'unknown section', 4: 'missing or duplicate section',
    5: 'bad trigger', 6: 'bad action', 7: 'parameter out of range', 8: 'undefined sequence',
    9: 'bad sequence',
  };

  function encode(cmd, seq, payload = []) {
    const msg = [...HEADER, PROTOCOL_VERSION, cmd, seq & 0x7f];
    for (const b of payload) msg.push(b >> 4, b & 0x0f);
    msg.push(0xf7);
    return msg;
  }

  // Returns {cmd, seq, payload: Uint8Array} or null.
  function decode(msg) {
    if (msg.length < 8 || msg[msg.length - 1] !== 0xf7) return null;
    for (let i = 0; i < 4; i++) if (msg[i] !== HEADER[i]) return null;
    if (msg[4] !== PROTOCOL_VERSION) return null;
    const n = msg.length - 8;
    if (n % 2) return null;
    const payload = new Uint8Array(n / 2);
    for (let i = 0; i < n / 2; i++) payload[i] = (msg[7 + 2 * i] << 4) | msg[8 + 2 * i];
    return { cmd: msg[5], seq: msg[6], payload };
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Little-endian byte helpers.
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
  const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const s16 = (v) => (v & 0x8000 ? v - 0x10000 : v);
  const s8 = (v) => (v & 0x80 ? v - 0x100 : v);

  // --- Rule table (spec part B) ---

  const TRIG = { PRESS: 1, RELEASE: 2, HOLD: 3, CLOCK: 4, LOAD: 5, ANALOG: 6, TAP: 7 };
  const ACT = {
    NONE: 0x00, NOTE: 0x01, CC: 0x02, SEQ_STEP: 0x10, SEQ_RUN: 0x11, SEQ_STOP: 0x12,
    SEQ_RESET: 0x13, SEQ_SELECT: 0x14, TRANSPOSE: 0x20, SET_SCALE: 0x21, PRESET: 0x30,
    MOD_RUN: 0x40, MOD_STOP: 0x41,
  };
  const GATE = { hold: 0, latch: 1, oneshot: 2 };
  const FLAG = { QUANTIZE: 0x04, VALUE_FROM_TRIGGER: 0x08, DEGREE: 0x10, REVERSE: 0x20 };
  const DEFAULT = 0xff;

  const SCALES = [
    { id: 'major', name: 'Major', mask: 0x0ab5 },
    { id: 'minor', name: 'Natural minor', mask: 0x05ad },
    { id: 'majpent', name: 'Major pentatonic', mask: 0x0295 },
    { id: 'minpent', name: 'Minor pentatonic', mask: 0x04a9 },
    { id: 'blues', name: 'Blues', mask: 0x04e9 },
    { id: 'dorian', name: 'Dorian', mask: 0x06ad },
    { id: 'mixolydian', name: 'Mixolydian', mask: 0x06b5 },
    { id: 'harmonic', name: 'Harmonic minor', mask: 0x09ad },
    { id: 'wholetone', name: 'Whole tone', mask: 0x0555 },
    { id: 'chromatic', name: 'Chromatic', mask: 0x0fff },
  ];
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  function noteName(n) {
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  }

  // Same calculation as the firmware's degree_to_note (spec B.5).
  function degreeToNote(deg, root, octave, mask) {
    const semis = [];
    for (let s = 0; s < 12; s++) if (mask & (1 << s)) semis.push(s);
    const n = semis.length;
    const oct = Math.floor(deg / n);
    const idx = deg - oct * n;
    return 12 * (octave + 1) + root + 12 * oct + semis[idx];
  }

  // Euclidean rhythm (spec B.6.1): position i is a hit if ((i + r) * k) % n < k.
  function euclidHits(steps, hits, rotation = 0) {
    return Array.from({ length: steps }, (_, i) => ((i + rotation) * hits) % steps < hits);
  }

  function section(id, body) {
    return [id, 0, ...u16(body.length), ...body];
  }

  function globalsBody(g) {
    const name = Array.from(g.name || '', (c) => c.charCodeAt(0) & 0x7f).slice(0, 16);
    while (name.length < 16) name.push(0);
    return [
      ...name, g.channel, g.velocity, g.root, g.octave, ...u16(g.mask), ...u16(g.tempo),
      g.debounceMs, g.ignoreClock ? 1 : 0, ...u16(g.lockoutMs), ...u16(g.holdMs),
      // Reserved: analog calibration is board-wide (spec B.10).
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
  }

  function rule(r) {
    return [
      r.trig, r.src || 0, ...u16(r.arg || 0), r.act, r.flags || 0, r.p0 || 0, r.p1 || 0,
      ...u16((r.p2 || 0) & 0xffff), ...u16((r.p3 || 0) & 0xffff),
    ];
  }

  // Sequence (spec B.6). steps: [{note, velocity, rest, length}]
  function sequenceBody(s) {
    return [
      s.id, s.advance, s.order, s.octaves, s.channel, s.velocity, s.division, s.gate,
      s.noteMode, 0, ...u16(s.steps.length),
      ...s.steps.flatMap((st) => [
        st.note & 0xff, st.velocity || 0, (st.rest ? 0x80 : 0) | (st.length || 1),
      ]),
    ];
  }

  // Modulator (spec B.6.2): an LFO (type 0) or envelope (type 1).
  function modulatorBody(m) {
    const tail = m.type === 0
      ? [m.wave, 0, ...u16(m.rate), 0, 0, 0, 0]
      : [m.sustain, m.follow, ...u16(m.attack), ...u16(m.decay), ...u16(m.release)];
    return [m.id, m.type, m.output, m.controller, m.channel, m.from, m.to, m.flags, ...tail];
  }

  // table: {globals, rules, sequences, modulators, extra: [raw section byte arrays]}
  function buildTable(table) {
    const sections = [
      section(0x01, globalsBody(table.globals)),
      section(0x02, [table.rules.length, 0, 0, 0, ...table.rules.flatMap(rule)]),
      ...(table.sequences || []).map((s) => section(0x03, sequenceBody(s))),
      ...(table.modulators || []).map((m) => section(0x05, modulatorBody(m))),
      ...(table.sequences || []).filter((s) => s.euclid)
        .map((s) => section(0x04, [s.id, s.euclid.steps, s.euclid.hits, s.euclid.rotation])),
      ...(table.extra || []),
    ];
    const body = sections.flat();
    const len = 8 + body.length;
    return new Uint8Array([...u16(1), ...u16(len), sections.length, 0, 0, 0, ...body]);
  }

  function parseTable(blob) {
    if (blob.length < 8 || rd16(blob, 0) !== 1) throw new Error('unsupported table format');
    const table = { globals: null, rules: [], sequences: [], modulators: [], extra: [] };
    const rhythms = [];  // EUCLID sections, attached to their sequences below
    let off = 8;
    for (let i = 0; i < blob[4]; i++) {
      const id = blob[off];
      const len = rd16(blob, off + 2);
      const b = blob.subarray(off + 4, off + 4 + len);
      if (id === 0x01) {
        table.globals = {
          name: String.fromCharCode(...b.subarray(0, 16)).replace(/\0+$/, ''),
          channel: b[16], velocity: b[17], root: b[18], octave: b[19],
          mask: rd16(b, 20), tempo: rd16(b, 22), debounceMs: b[24], ignoreClock: !!(b[25] & 1),
          lockoutMs: rd16(b, 26), holdMs: rd16(b, 28),
        };
      } else if (id === 0x02) {
        for (let r = 0; r < b[0]; r++) {
          const p = 4 + 12 * r;
          table.rules.push({
            trig: b[p], src: b[p + 1], arg: rd16(b, p + 2), act: b[p + 4], flags: b[p + 5],
            p0: b[p + 6], p1: b[p + 7], p2: s16(rd16(b, p + 8)), p3: rd16(b, p + 10),
          });
        }
      } else if (id === 0x03) {
        const noteMode = b[8];
        const steps = [];
        for (let s = 0; s < rd16(b, 10); s++) {
          const p = 12 + 3 * s;
          steps.push({
            note: noteMode ? s8(b[p]) : b[p], velocity: b[p + 1],
            rest: !!(b[p + 2] & 0x80), length: b[p + 2] & 0x7f,
          });
        }
        table.sequences.push({
          id: b[0], advance: b[1], order: b[2], octaves: b[3], channel: b[4],
          velocity: b[5], division: b[6], gate: b[7], noteMode, steps, euclid: null,
        });
      } else if (id === 0x05) {
        const m = { id: b[0], type: b[1], output: b[2], controller: b[3], channel: b[4], from: b[5], to: b[6], flags: b[7] };
        if (m.type === 0) Object.assign(m, { wave: b[8], rate: rd16(b, 10) });
        else Object.assign(m, { sustain: b[8], follow: b[9], attack: rd16(b, 10), decay: rd16(b, 12), release: rd16(b, 14) });
        table.modulators.push(m);
      } else if (id === 0x04) {
        rhythms.push({ id: b[0], euclid: { steps: b[1], hits: b[2], rotation: b[3] } });
      } else {
        table.extra.push(Array.from(blob.subarray(off, off + 4 + len)));
      }
      off += 4 + len;
    }
    for (const r of rhythms) {
      const q = table.sequences.find((s) => s.id === r.id);
      if (q) q.euclid = r.euclid;
    }
    return table;
  }

  // --- Form view model <-> rule table ---
  //
  // The form edits a simple model: one action per switch, one CC per analog
  // input, and up to four sequences A-D. Tables made by other editors
  // (tap/hold, several rules per switch...) can't be shown in it;
  // formFromTable says why.

  const ORDERS = ['written', 'up', 'down', 'updown', 'random'];
  const WAVES = ['sine', 'triangle', 'saw', 'square', 'random'];
  const MOD_OUTPUTS = ['cc', 'bend', 'pressure'];
  const MAX_FORM_STEPS = 32;
  const SEQ_ACTIONS = { 'seq-play': ACT.SEQ_RUN, 'seq-step': ACT.SEQ_STEP, 'seq-restart': ACT.SEQ_RESET };
  const MOD_ACTIONS = { 'mod-run': ACT.MOD_RUN, 'mod-stop': ACT.MOD_STOP };

  function defaultSequence() {
    // notes: scale degrees or MIDI notes (by noteType), null = rest
    return {
      mode: 'clock', noteType: 'scale', notes: [], order: 'written', octaves: 1,
      division: 6, gate: 80,
      rhythm: null,  // or {steps, hits, rotation}: a Euclidean rhythm (clock mode)
    };
  }

  // A modulator in the form. kind: 'off', 'lfo' or 'env'. LFO speed: synced
  // (rate = clock ticks per cycle) or free (rate = hundredths of a hertz).
  function defaultModulator(kind = 'off') {
    return {
      kind, output: 'cc', cc: 74, from: 0, to: 127, exponential: false,
      wave: 'triangle', synced: true, rate: 96,
      attack: 500, decay: 300, sustain: 100, release: 800, follow: null,
    };
  }

  function defaultForm() {
    return {
      name: 'Scale player', channel: 0, velocity: 100, root: 0, octave: 4, mask: 0x0ab5,
      holdMs: 500, lockoutMs: 0, debounceMs: 10, tempo: 1200, ignoreClock: false,
      switches: [
        ...Array.from({ length: 10 }, (_, i) => ({ action: 'scale', degree: i, gate: 'hold' })),
        { action: 'transpose', semitones: -12 },
        { action: 'transpose', semitones: 12 },
      ],
      analog: [{ cc: 1 }, { cc: 74 }],
      sequences: Array.from({ length: 4 }, defaultSequence),
      modulators: Array.from({ length: 4 }, () => defaultModulator()),
    };
  }

  // A sequence with no notes isn't sent to the board, and switches using it
  // do nothing (the page warns about this).
  function sequenceInUse(f, id) {
    return f.sequences[id] && f.sequences[id].notes.length > 0;
  }

  function tableFromForm(f) {
    const rules = [];
    f.switches.forEach((s, i) => {
      if (s.action === 'scale' || s.action === 'note') {
        const degree = s.action === 'scale';
        rules.push({
          trig: TRIG.PRESS, src: i, act: ACT.NOTE,
          flags: GATE[s.gate] | (degree ? FLAG.DEGREE : 0),
          p0: DEFAULT, p1: 0, p2: degree ? s.degree : s.note,
        });
      } else if (s.action === 'transpose') {
        rules.push({ trig: TRIG.PRESS, src: i, act: ACT.TRANSPOSE, p0: 1, p2: s.semitones });
      } else if (s.action in MOD_ACTIONS && f.modulators && f.modulators[s.mod].kind !== 'off') {
        const flags = s.action === 'mod-run' ? GATE[s.gate] | (s.onBeat ? FLAG.QUANTIZE : 0) : 0;
        rules.push({ trig: TRIG.PRESS, src: i, act: MOD_ACTIONS[s.action], flags, p0: s.mod });
      } else if (s.action in SEQ_ACTIONS && sequenceInUse(f, s.seq)) {
        const flags = s.action === 'seq-play' ? GATE[s.gate] | (s.onBeat ? FLAG.QUANTIZE : 0) : 0;
        rules.push({ trig: TRIG.PRESS, src: i, act: SEQ_ACTIONS[s.action], flags, p0: s.seq });
      }
    });
    f.analog.forEach((a, i) => {
      if (a.cc !== null)
        rules.push({
          trig: TRIG.ANALOG, src: i, act: ACT.CC,
          flags: FLAG.VALUE_FROM_TRIGGER | (a.reversed ? FLAG.REVERSE : 0),
          p0: DEFAULT, p1: a.cc,
        });
    });
    const sequences = [];
    (f.sequences || []).forEach((q, id) => {
      if (!q.notes.length) return;
      sequences.push({
        id, advance: q.mode === 'clock' ? 1 : 0, order: ORDERS.indexOf(q.order),
        octaves: q.octaves, channel: DEFAULT, velocity: 0, division: q.division,
        // Clock mode needs a length; "until the next note" only exists in press mode.
        gate: q.mode === 'clock' && q.gate === 0 ? 100 : q.gate,
        noteMode: q.noteType === 'scale' ? 1 : 0,
        steps: q.notes.map((n) => (n === null
          ? { note: 0, velocity: 0, rest: true, length: 1 }
          : { note: n, velocity: 0, rest: false, length: 1 })),
        euclid: q.mode === 'clock' && q.rhythm ? { ...q.rhythm } : null,
      });
    });
    const modulators = [];
    (f.modulators || []).forEach((m, id) => {
      if (m.kind === 'off') return;
      const base = {
        id, type: m.kind === 'lfo' ? 0 : 1, output: MOD_OUTPUTS.indexOf(m.output),
        controller: m.output === 'cc' ? m.cc : 0, channel: DEFAULT, from: m.from, to: m.to,
        flags: (m.exponential ? 1 : 0) | (m.kind === 'lfo' && m.synced ? 2 : 0),
      };
      modulators.push(m.kind === 'lfo'
        ? { ...base, wave: WAVES.indexOf(m.wave), rate: m.rate }
        : {
          ...base, sustain: m.sustain, attack: m.attack, decay: m.decay, release: m.release,
          // An envelope can only follow a sequence that has notes.
          follow: m.follow !== null && sequenceInUse(f, m.follow) ? m.follow : DEFAULT,
        });
    });
    return { globals: { ...f }, rules, sequences, modulators };
  }

  // Returns {form} or {reason} if the table uses things the form can't show.
  function formFromTable(table) {
    const g = table.globals;
    const f = {
      name: g.name, channel: g.channel, velocity: g.velocity, root: g.root, octave: g.octave,
      mask: g.mask, holdMs: g.holdMs, lockoutMs: g.lockoutMs, debounceMs: g.debounceMs,
      tempo: g.tempo, ignoreClock: !!g.ignoreClock,
      switches: Array.from({ length: NUM_INPUTS }, () => ({ action: 'none' })),
      analog: Array.from({ length: NUM_ANALOG }, () => ({ cc: null })),
      sequences: Array.from({ length: 4 }, defaultSequence),
      modulators: Array.from({ length: 4 }, () => defaultModulator()),
    };
    if ((table.extra || []).length) return { reason: 'it has sections the form doesn’t edit' };

    for (const q of table.sequences || []) {
      const simple = q.id < 4 && q.channel === DEFAULT && q.velocity === 0 &&
        q.steps.length <= MAX_FORM_STEPS &&
        q.steps.every((st) => st.velocity === 0 && st.length <= 1);
      if (!simple) return { reason: 'its sequences use settings the form doesn’t show' };
      f.sequences[q.id] = {
        mode: q.advance ? 'clock' : 'press', noteType: q.noteMode ? 'scale' : 'fixed',
        notes: q.steps.map((st) => (st.rest ? null : st.note)),
        order: ORDERS[q.order], octaves: q.octaves, division: q.division, gate: q.gate,
        rhythm: q.euclid ? { ...q.euclid } : null,
      };
    }

    for (const m of table.modulators || []) {
      if (m.id > 3 || m.channel !== DEFAULT) return { reason: 'its modulators use settings the form doesn’t show' };
      const fm = {
        ...defaultModulator(m.type === 0 ? 'lfo' : 'env'), output: MOD_OUTPUTS[m.output],
        cc: m.output === 0 ? m.controller : 74, from: m.from, to: m.to, exponential: !!(m.flags & 1),
      };
      if (m.type === 0) Object.assign(fm, { wave: WAVES[m.wave], synced: !!(m.flags & 2), rate: m.rate });
      else Object.assign(fm, {
        attack: m.attack, decay: m.decay, sustain: m.sustain, release: m.release,
        follow: m.follow === DEFAULT ? null : m.follow,
      });
      f.modulators[m.id] = fm;
    }

    const usedSwitch = new Set();
    const usedAnalog = new Set();
    for (const r of table.rules) {
      const gate = Object.keys(GATE).find((k) => GATE[k] === (r.flags & 3));
      if (r.trig === TRIG.PRESS && r.src < NUM_INPUTS && !usedSwitch.has(r.src)) {
        let s = null;
        if (r.act === ACT.NOTE && (r.flags & ~(3 | FLAG.DEGREE)) === 0 && gate &&
            r.p0 === DEFAULT && r.p1 === 0 && r.p3 === 0) {
          s = r.flags & FLAG.DEGREE
            ? { action: 'scale', degree: r.p2, gate }
            : { action: 'note', note: r.p2, gate };
        } else if (r.act === ACT.TRANSPOSE && r.flags === 0 && r.p0 === 1) {
          s = { action: 'transpose', semitones: r.p2 };
        } else if (r.act === ACT.SEQ_RUN && (r.flags & ~(3 | FLAG.QUANTIZE)) === 0 && gate &&
                   r.p0 < 4) {
          s = { action: 'seq-play', seq: r.p0, gate, onBeat: !!(r.flags & FLAG.QUANTIZE) };
        } else if (r.act === ACT.MOD_RUN && (r.flags & ~(3 | FLAG.QUANTIZE)) === 0 && gate && r.p0 < 4) {
          s = { action: 'mod-run', mod: r.p0, gate, onBeat: !!(r.flags & FLAG.QUANTIZE) };
        } else if (r.act === ACT.MOD_STOP && r.flags === 0 && r.p0 < 4) {
          s = { action: 'mod-stop', mod: r.p0 };
        } else if ((r.act === ACT.SEQ_STEP || r.act === ACT.SEQ_RESET) && r.flags === 0 && r.p0 < 4) {
          s = { action: r.act === ACT.SEQ_STEP ? 'seq-step' : 'seq-restart', seq: r.p0 };
        }
        if (s) {
          f.switches[r.src] = s;
          usedSwitch.add(r.src);
          continue;
        }
      }
      if (r.trig === TRIG.ANALOG && r.act === ACT.CC && (r.flags & ~FLAG.REVERSE) === FLAG.VALUE_FROM_TRIGGER &&
          r.p0 === DEFAULT && !usedAnalog.has(r.src)) {
        // {cc} normally, {cc, reversed: true} when this preset flips the input.
        f.analog[r.src] = r.flags & FLAG.REVERSE ? { cc: r.p1, reversed: true } : { cc: r.p1 };
        usedAnalog.add(r.src);
        continue;
      }
      return { reason: 'it uses rules the form doesn’t show (such as tap, hold or presets)' };
    }
    return { form: f };
  }

  // --- Starter templates (plan: "Templates and presets") ---
  // Each returns a fresh form. Names fit the board's 16 characters.

  function seq(mode, noteType, notes, extra = {}) {
    return { ...defaultSequence(), mode, noteType, notes, ...extra };
  }

  const TEMPLATES = [
    {
      id: 'scale', name: 'Scale player',
      description: 'Switches 1–10 play up the scale; the buttons shift an octave down and up.',
      form: () => defaultForm(),
    },
    {
      id: 'arp', name: 'Chord arpeggiator',
      description: 'Four chords as arpeggios. Switches 1–4 play while held, 5–8 start and stop on the beat. 9–10 are bass notes.',
      form: () => {
        const f = defaultForm();
        f.name = 'Chord arp';
        f.tempo = 1100;
        const arp = { order: 'up', octaves: 2, division: 6, gate: 70 };
        // I, IV, V and vi of the current key, as scale degrees.
        f.sequences = [[0, 2, 4], [3, 5, 7], [4, 6, 8], [5, 7, 9]].map((n) => seq('clock', 'scale', n, arp));
        for (let i = 0; i < 4; i++) {
          f.switches[i] = { action: 'seq-play', seq: i, gate: 'hold', onBeat: false };
          f.switches[i + 4] = { action: 'seq-play', seq: i, gate: 'latch', onBeat: true };
        }
        f.switches[8] = { action: 'scale', degree: -7, gate: 'hold' };
        f.switches[9] = { action: 'scale', degree: -3, gate: 'hold' };
        return f;
      },
    },
    {
      id: 'tune', name: 'Tune stepper',
      description: 'Each press plays the next note of a tune: Ode to Joy on switch 1, Twinkle Twinkle on switch 3. Switches 2 and 4 go back to the start; 5–10 play scale notes.',
      form: () => {
        const f = defaultForm();
        f.name = 'Tune stepper';
        const ode = [2, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1, 2, 2, 1, 1,
          2, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1, 2, 1, 0, 0];
        const twinkle = [0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0];
        f.sequences[0] = seq('press', 'scale', ode, { order: 'written', gate: 0 });
        f.sequences[1] = seq('press', 'scale', twinkle, { order: 'written', gate: 0 });
        f.switches[0] = { action: 'seq-step', seq: 0 };
        f.switches[1] = { action: 'seq-restart', seq: 0 };
        f.switches[2] = { action: 'seq-step', seq: 1 };
        f.switches[3] = { action: 'seq-restart', seq: 1 };
        for (let i = 4; i < 10; i++) f.switches[i] = { action: 'scale', degree: i - 4, gate: 'hold' };
        return f;
      },
    },
    {
      id: 'drums', name: 'Drum pads',
      description: 'General MIDI drums on channel 10, one per switch. The buttons start and stop a beat and a hi-hat pattern. Best with a DAW drum kit.',
      form: () => {
        const f = defaultForm();
        f.name = 'Drum pads';
        f.channel = 9;
        // Kick, snare, closed hat, open hat, clap, low tom, high tom, crash, ride, cowbell
        [36, 38, 42, 46, 39, 45, 48, 49, 51, 56].forEach((note, i) => {
          f.switches[i] = { action: 'note', note, gate: 'oneshot' };
        });
        f.sequences[0] = seq('clock', 'fixed', [36, null, 38, null, 36, 36, 38, null],
          { order: 'written', division: 12, gate: 50 });
        f.sequences[1] = seq('clock', 'fixed', [42, 42, 42, 46],
          { order: 'written', division: 12, gate: 50 });
        f.switches[10] = { action: 'seq-play', seq: 0, gate: 'latch', onBeat: true };
        f.switches[11] = { action: 'seq-play', seq: 1, gate: 'latch', onBeat: true };
        f.analog = [{ cc: 7 }, { cc: null }];
        return f;
      },
    },
    {
      id: 'euclid', name: 'Euclidean drums',
      description: 'Four drum parts with Euclidean rhythms. Switches 1–4 start and stop them on the beat; 5–10 are drum pads. Best with a DAW drum kit.',
      form: () => {
        const f = defaultForm();
        f.name = 'Euclid drums';
        f.channel = 9;
        f.tempo = 1000;
        const part = (note, steps, hits, rotation) => seq('clock', 'fixed', [note],
          { order: 'written', division: 6, gate: 50, rhythm: { steps, hits, rotation } });
        f.sequences = [part(36, 16, 5, 0), part(38, 16, 3, 4), part(42, 8, 7, 0), part(45, 12, 4, 2)];
        for (let i = 0; i < 4; i++) f.switches[i] = { action: 'seq-play', seq: i, gate: 'latch', onBeat: true };
        [36, 38, 42, 46, 39, 49].forEach((note, i) => {
          f.switches[4 + i] = { action: 'note', note, gate: 'oneshot' };
        });
        f.analog = [{ cc: 7 }, { cc: null }];
        return f;
      },
    },
    {
      id: 'mod', name: 'Sweeps & wobbles',
      description: 'Modulation: switch 1 sweeps the brightness up while held; 2 starts and stops a slow vibrato wobble; 3 bends each note up and back; 4 plays an arpeggio whose notes each get a brightness pluck. 5–10 play scale notes.',
      form: () => {
        const f = defaultForm();
        f.name = 'Sweeps & wobbles';
        const mod = (kind, extra) => ({ ...defaultModulator(kind), ...extra });
        f.modulators = [
          mod('env', { output: 'cc', cc: 74, from: 10, to: 127, exponential: true, attack: 1500, decay: 0, sustain: 100, release: 1200 }),
          mod('lfo', { output: 'cc', cc: 1, from: 0, to: 90, wave: 'triangle', synced: true, rate: 96 }),
          mod('env', { output: 'bend', from: 64, to: 76, attack: 60, decay: 300, sustain: 0, release: 0 }),
          mod('env', { output: 'cc', cc: 74, from: 20, to: 110, attack: 5, decay: 150, sustain: 30, release: 120, follow: 0 }),
        ];
        f.sequences[0] = seq('clock', 'scale', [0, 2, 4], { order: 'up', octaves: 2, division: 6, gate: 60 });
        f.switches[0] = { action: 'mod-run', mod: 0, gate: 'hold', onBeat: false };
        f.switches[1] = { action: 'mod-run', mod: 1, gate: 'latch', onBeat: true };
        f.switches[2] = { action: 'mod-run', mod: 2, gate: 'oneshot', onBeat: false };
        f.switches[3] = { action: 'seq-play', seq: 0, gate: 'hold', onBeat: false };
        for (let i = 4; i < 10; i++) f.switches[i] = { action: 'scale', degree: i - 4, gate: 'hold' };
        return f;
      },
    },
  ];

  // --- Preset files ---
  // A JSON file holding the rule table (hex, exactly what the board runs) and
  // the Blockly workspace (layout and unfinished blocks included).

  const FILE_FORMAT = 'switchcraft-preset';
  const FILE_VERSION = 1;
  const MAX_TABLE_LEN = 4080;

  const toHexString = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function presetFile(table, blocks) {
    return {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      name: table.globals.name,
      saved: new Date().toISOString(),
      tableFormat: 1,
      table: toHexString(buildTable(table)),
      blocks: blocks || null,
    };
  }

  // Returns {name, table, blocks} or throws an Error with a message for people.
  function readPresetFile(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('This isn’t a Switchcraft preset file.');
    }
    if (!data || typeof data !== 'object' || data.format !== FILE_FORMAT)
      throw new Error('This isn’t a Switchcraft preset file.');
    if (!Number.isInteger(data.version) || data.version > FILE_VERSION)
      throw new Error('This file was saved by a newer version of the Switchcraft page. Update the page to open it.');
    const hex = typeof data.table === 'string' ? data.table : '';
    if (!/^([0-9a-f]{2})+$/i.test(hex) || hex.length / 2 > MAX_TABLE_LEN)
      throw new Error('The preset in this file is damaged.');
    const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
    let table;
    try {
      table = parseTable(bytes);
    } catch (e) {
      table = null;
    }
    if (!table || !table.globals || rd16(bytes, 2) !== bytes.length)
      throw new Error('The preset in this file is damaged or was made for newer firmware.');
    const blocks = data.blocks && typeof data.blocks === 'object' && !Array.isArray(data.blocks) ? data.blocks : null;
    return { name: table.globals.name, table, blocks };
  }

  // A file name from the preset name: "Chord arp" -> "chord-arp.switchcraft.json".
  function presetFileName(name) {
    const base = String(name || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
    return `${base || 'preset'}.switchcraft.json`;
  }

  // --- Board connection over Web MIDI ---

  class BoardError extends Error {}

  class Board {
    constructor(input, output) {
      this.input = input;
      this.output = output;
      this.seq = 0;
      this.pending = null;   // request awaiting its reply
      this.chain = Promise.resolve();  // one request at a time
      this.onInput = null;   // (input, event)
      this.onAnalog = null;  // (analog, raw, value)
      this.onSlot = null;    // (slot)
      this.onClock = null;   // (external, bpm)
      this.onMidi = null;    // (data) musical messages copied to port 2
      input.onmidimessage = (e) => this._receive(e.data);
    }

    // Finds the config port pair: sends IDENTIFY on every Switchcraft-like
    // output and sees which input answers (only port 2 accepts config SysEx).
    static async find(access) {
      const like = (p) => /switchcraft/i.test(p.name);
      const outputs = [...access.outputs.values()].filter(like);
      const inputs = [...access.inputs.values()].filter(like);
      for (const output of outputs) {
        for (const input of inputs) {
          const board = new Board(input, output);
          try {
            board.info = await board.identify(400);
            return board;
          } catch (e) {
            board.close();
          }
        }
      }
      return null;
    }

    close() {
      this.input.onmidimessage = null;
    }

    _receive(data) {
      if (data[0] !== 0xf0) {
        if (this.onMidi) this.onMidi(data);
        return;
      }
      const m = decode(data);
      if (!m) return;
      const p = m.payload;
      if (m.cmd === REPORT.INPUT && this.onInput) this.onInput(p[0], EVENTS[p[1]]);
      else if (m.cmd === REPORT.ANALOG && this.onAnalog) this.onAnalog(p[0], rd16(p, 1), p[3]);
      else if (m.cmd === REPORT.SLOT && this.onSlot) this.onSlot(p[0]);
      else if (m.cmd === REPORT.CLOCK && this.onClock) this.onClock(p[0] === 1, rd16(p, 1) / 10);
      else if (this.pending && m.cmd === (this.pending.cmd | 0x40) && m.seq === this.pending.seq)
        this.pending.resolve(p);
    }

    // Sends one command and resolves with the reply's data (after status).
    request(cmd, payload = [], timeout = 1000) {
      const run = () => new Promise((resolve, reject) => {
        this.seq = (this.seq + 1) & 0x7f;
        const name = Object.keys(CMD).find((k) => CMD[k] === cmd);
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new BoardError(`${name}: no reply`));
        }, timeout);
        this.pending = {
          cmd, seq: this.seq,
          resolve: (p) => {
            clearTimeout(timer);
            this.pending = null;
            if (p[0] === 0) return resolve(p.subarray(1));
            let msg = `${name}: ${STATUS[p[0]] || p[0]}`;
            if (p[0] === 0x07 && p.length === 4)
              msg += ` at byte ${rd16(p, 1)} (${INVALID[p[3]] || p[3]})`;
            const err = new BoardError(msg);
            err.status = p[0];
            reject(err);
          },
        };
        this.output.send(encode(cmd, this.seq, payload));
      });
      const result = this.chain.then(run, run);
      this.chain = result.catch(() => {});
      return result;
    }

    async identify(timeout) {
      const d = await this.request(CMD.IDENTIFY, [], timeout);
      return {
        protocol: d[0], firmware: `${d[1]}.${d[2]}.${d[3]}`, hwRevision: d[4],
        uniqueId: Array.from(d.subarray(5, 13), (b) => b.toString(16).padStart(2, '0')).join(''),
        tableFormat: rd16(d, 13), inputs: d[15], analog: d[16], slots: d[17],
        activeSlot: d[18], maxTable: rd16(d, 19), maxRules: d[21], maxSequences: d[22],
      };
    }

    async tableInfo(source) {
      const d = await this.request(CMD.TABLE_INFO, [source]);
      return { length: rd16(d, 0), crc: rd32(d, 2), format: rd16(d, 6) };
    }

    async readTable(source = SOURCE_WORKING) {
      const { length, crc } = await this.tableInfo(source);
      const blob = new Uint8Array(length);
      for (let off = 0; off < length; off += CHUNK) {
        const n = Math.min(CHUNK, length - off);
        const d = await this.request(CMD.TABLE_READ, [source, ...u16(off), n]);
        blob.set(d.subarray(2), off);
      }
      if (crc32(blob) !== crc) throw new BoardError('CRC mismatch reading table');
      return blob;
    }

    // restart: start the preset afresh (template, opened file); otherwise an
    // edit, which keeps playing sequences going (spec A.4).
    async writeTable(blob, save = false, restart = false) {
      await this.request(CMD.WRITE_BEGIN, [...u16(blob.length), ...u32(crc32(blob))]);
      for (let off = 0; off < blob.length; off += CHUNK)
        await this.request(CMD.WRITE_DATA, [...u16(off), ...blob.subarray(off, off + CHUNK)]);
      await this.request(CMD.WRITE_COMMIT, [(save ? 1 : 0) | (restart ? 2 : 0)], 2000);
    }

    saveSlot(slot) { return this.request(CMD.SLOT_SAVE, [slot], 2000); }
    loadSlot(slot) { return this.request(CMD.SLOT_LOAD, [slot], 2000); }
    eraseSlot(slot) { return this.request(CMD.SLOT_ERASE, [slot], 2000); }
    allNotesOff() { return this.request(CMD.ALL_NOTES_OFF); }

    // Board-wide analog calibration (spec B.10): raw readings mapped to 0
    // (min) and 127 (max) for each analog input; max < min inverts.
    async getCalibration() {
      const d = await this.request(CMD.CALIBRATION_GET);
      return { min: [rd16(d, 0), rd16(d, 2)], max: [rd16(d, 4), rd16(d, 6)] };
    }

    setCalibration({ min, max }, save) {
      return this.request(CMD.CALIBRATION_SET,
        [save ? 1 : 0, ...u16(min[0]), ...u16(min[1]), ...u16(max[0]), ...u16(max[1])], 2000);
    }
  }

  global.Switchcraft = {
    CMD, REPORT, TRIG, ACT, GATE, FLAG, DEFAULT, SCALES, NOTE_NAMES,
    NUM_INPUTS, NUM_ANALOG, NUM_SLOTS, SOURCE_WORKING, DEFAULT_CALIBRATION,
    encode, decode, crc32, noteName, degreeToNote,
    ORDERS, MAX_FORM_STEPS, TEMPLATES, euclidHits, WAVES, defaultModulator,
    presetFile, readPresetFile, presetFileName,
    buildTable, parseTable, defaultForm, defaultSequence, sequenceInUse,
    tableFromForm, formFromTable,
    Board, BoardError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
