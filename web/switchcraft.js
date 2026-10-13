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

  const CMD = {
    IDENTIFY: 0x01, TABLE_INFO: 0x02, TABLE_READ: 0x03, WRITE_BEGIN: 0x04,
    WRITE_DATA: 0x05, WRITE_COMMIT: 0x06, SLOT_SAVE: 0x07, SLOT_LOAD: 0x08,
    SLOT_ERASE: 0x09, ALL_NOTES_OFF: 0x0a,
  };
  const REPORT = { INPUT: 0x60, ANALOG: 0x61, SLOT: 0x62 };
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
  };
  const GATE = { hold: 0, latch: 1, oneshot: 2 };
  const FLAG = { QUANTIZE: 0x04, VALUE_FROM_TRIGGER: 0x08, DEGREE: 0x10 };
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

  function section(id, body) {
    return [id, 0, ...u16(body.length), ...body];
  }

  function globalsBody(g) {
    const name = Array.from(g.name || '', (c) => c.charCodeAt(0) & 0x7f).slice(0, 16);
    while (name.length < 16) name.push(0);
    return [
      ...name, g.channel, g.velocity, g.root, g.octave, ...u16(g.mask), ...u16(g.tempo),
      g.debounceMs, 0, ...u16(g.lockoutMs), ...u16(g.holdMs),
      ...u16(g.analogMin[0]), ...u16(g.analogMin[1]),
      ...u16(g.analogMax[0]), ...u16(g.analogMax[1]), 0, 0,
    ];
  }

  function rule(r) {
    return [
      r.trig, r.src || 0, ...u16(r.arg || 0), r.act, r.flags || 0, r.p0 || 0, r.p1 || 0,
      ...u16((r.p2 || 0) & 0xffff), ...u16((r.p3 || 0) & 0xffff),
    ];
  }

  // table: {globals, rules: [...], extra: [raw section byte arrays]}
  function buildTable(table) {
    const sections = [
      section(0x01, globalsBody(table.globals)),
      section(0x02, [table.rules.length, 0, 0, 0, ...table.rules.flatMap(rule)]),
      ...(table.extra || []),
    ];
    const body = sections.flat();
    const len = 8 + body.length;
    return new Uint8Array([...u16(1), ...u16(len), sections.length, 0, 0, 0, ...body]);
  }

  function parseTable(blob) {
    if (blob.length < 8 || rd16(blob, 0) !== 1) throw new Error('unsupported table format');
    const table = { globals: null, rules: [], sequences: [], extra: [] };
    let off = 8;
    for (let i = 0; i < blob[4]; i++) {
      const id = blob[off];
      const len = rd16(blob, off + 2);
      const b = blob.subarray(off + 4, off + 4 + len);
      if (id === 0x01) {
        table.globals = {
          name: String.fromCharCode(...b.subarray(0, 16)).replace(/\0+$/, ''),
          channel: b[16], velocity: b[17], root: b[18], octave: b[19],
          mask: rd16(b, 20), tempo: rd16(b, 22), debounceMs: b[24],
          lockoutMs: rd16(b, 26), holdMs: rd16(b, 28),
          analogMin: [rd16(b, 30), rd16(b, 32)], analogMax: [rd16(b, 34), rd16(b, 36)],
        };
      } else if (id === 0x02) {
        for (let r = 0; r < b[0]; r++) {
          const p = 4 + 12 * r;
          table.rules.push({
            trig: b[p], src: b[p + 1], arg: rd16(b, p + 2), act: b[p + 4], flags: b[p + 5],
            p0: b[p + 6], p1: b[p + 7], p2: s16(rd16(b, p + 8)), p3: rd16(b, p + 10),
          });
        }
      } else {
        if (id === 0x03) table.sequences.push({ id: b[0], steps: rd16(b, 10) });
        table.extra.push(Array.from(blob.subarray(off, off + 4 + len)));
      }
      off += 4 + len;
    }
    return table;
  }

  // --- Form view model <-> rule table ---
  //
  // The form edits a simple model: one action per switch, one CC per analog
  // input. Tables made by other editors (sequences, tap/hold, several rules
  // per switch...) can't be shown in it; formFromTable says why.

  function defaultForm() {
    return {
      name: 'Scale player', channel: 0, velocity: 100, root: 0, octave: 4, mask: 0x0ab5,
      holdMs: 500, lockoutMs: 0, debounceMs: 10, tempo: 1200,
      analogMin: [0, 0], analogMax: [4095, 4095],
      switches: [
        ...Array.from({ length: 10 }, (_, i) => ({ action: 'scale', degree: i, gate: 'hold' })),
        { action: 'transpose', semitones: -12 },
        { action: 'transpose', semitones: 12 },
      ],
      analog: [{ cc: 1 }, { cc: 74 }],
    };
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
      }
    });
    f.analog.forEach((a, i) => {
      if (a.cc !== null)
        rules.push({
          trig: TRIG.ANALOG, src: i, act: ACT.CC, flags: FLAG.VALUE_FROM_TRIGGER,
          p0: DEFAULT, p1: a.cc,
        });
    });
    return { globals: { ...f }, rules };
  }

  // Returns {form} or {reason} if the table uses things the form can't show.
  function formFromTable(table) {
    const g = table.globals;
    const f = {
      name: g.name, channel: g.channel, velocity: g.velocity, root: g.root, octave: g.octave,
      mask: g.mask, holdMs: g.holdMs, lockoutMs: g.lockoutMs, debounceMs: g.debounceMs,
      tempo: g.tempo, analogMin: g.analogMin, analogMax: g.analogMax,
      switches: Array.from({ length: NUM_INPUTS }, () => ({ action: 'none' })),
      analog: Array.from({ length: NUM_ANALOG }, () => ({ cc: null })),
    };
    if (table.sequences.length) return { reason: 'it uses sequences or arpeggios' };
    if (table.extra.length) return { reason: 'it has sections the form doesn’t edit' };
    const usedSwitch = new Set();
    const usedAnalog = new Set();
    for (const r of table.rules) {
      const gate = Object.keys(GATE).find((k) => GATE[k] === (r.flags & 3));
      if (r.trig === TRIG.PRESS && r.src < NUM_INPUTS && !usedSwitch.has(r.src)) {
        if (r.act === ACT.NOTE && (r.flags & ~(3 | FLAG.DEGREE)) === 0 && gate &&
            r.p0 === DEFAULT && r.p1 === 0 && r.p3 === 0) {
          f.switches[r.src] = r.flags & FLAG.DEGREE
            ? { action: 'scale', degree: r.p2, gate }
            : { action: 'note', note: r.p2, gate };
          usedSwitch.add(r.src);
          continue;
        }
        if (r.act === ACT.TRANSPOSE && r.flags === 0 && r.p0 === 1) {
          f.switches[r.src] = { action: 'transpose', semitones: r.p2 };
          usedSwitch.add(r.src);
          continue;
        }
      }
      if (r.trig === TRIG.ANALOG && r.act === ACT.CC && r.flags === FLAG.VALUE_FROM_TRIGGER &&
          r.p0 === DEFAULT && !usedAnalog.has(r.src)) {
        f.analog[r.src] = { cc: r.p1 };
        usedAnalog.add(r.src);
        continue;
      }
      return { reason: 'it uses rules the form doesn’t show (such as tap, hold or presets)' };
    }
    return { form: f };
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

    async writeTable(blob, save = false) {
      await this.request(CMD.WRITE_BEGIN, [...u16(blob.length), ...u32(crc32(blob))]);
      for (let off = 0; off < blob.length; off += CHUNK)
        await this.request(CMD.WRITE_DATA, [...u16(off), ...blob.subarray(off, off + CHUNK)]);
      await this.request(CMD.WRITE_COMMIT, [save ? 1 : 0], 2000);
    }

    saveSlot(slot) { return this.request(CMD.SLOT_SAVE, [slot], 2000); }
    loadSlot(slot) { return this.request(CMD.SLOT_LOAD, [slot], 2000); }
    eraseSlot(slot) { return this.request(CMD.SLOT_ERASE, [slot], 2000); }
    allNotesOff() { return this.request(CMD.ALL_NOTES_OFF); }
  }

  global.Switchcraft = {
    CMD, REPORT, TRIG, ACT, GATE, FLAG, DEFAULT, SCALES, NOTE_NAMES,
    NUM_INPUTS, NUM_ANALOG, NUM_SLOTS, SOURCE_WORKING,
    encode, decode, crc32, noteName, degreeToNote,
    buildTable, parseTable, defaultForm, tableFromForm, formFromTable,
    Board, BoardError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
