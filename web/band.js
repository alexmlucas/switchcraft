// band.js: the model behind the editor (no page code).
//
// A band is the form model from switchcraft.js (key, tempo, analog inputs,
// sequences A-D, modulators 1-4, generators) plus a list of devices and each
// switch's access settings.
//
// You start from the switches: choose one or more, then give them a device
// (notes, a melody generator, a sequencer, an arpeggiator, a wobble, a swell
// or controls). A switch belongs to one device at most. A device has a few
// jobs ("roles") in priority order, the first being the one that makes a
// sound, so a device with one switch always plays something; more switches
// take the next jobs in turn. Each device has its own MIDI channel, loudness
// and colour.
//
// What is tailored to a person lives on the switch, not the device: a label
// ("Sam, head switch"), "ignore repeat presses within" and "counts as held
// after". Those go to the board per switch (INPUTS section, firmware 0.7.0).
//
// The band compiles to the same rule table as the form. The devices, labels
// and colours travel with it in the table's EDITOR section (spec B.7), which
// the firmware stores but never reads, so a preset read back from the board
// reopens as it was.
(function (global) {
  'use strict';

  const S = global.Switchcraft;
  const EDITOR_ID = 0x10;
  const EDITOR_VERSION = 2;
  const MAX_TABLE_LEN = 4080;
  // Switches 1-10. The L and R buttons (inputs 10 and 11) only map the
  // analog inputs (firmware 0.7.2), so they aren't offered.
  const NUM_SWITCHES = 10;
  const NUM_SEQS = 4;
  const NUM_MODS = 4;
  const NUM_GENS = S.NUM_GENS;
  const DEFAULT_HOLD_MS = 500;
  const MAX_LABEL = 32;

  // Soft brand colours, each with a symbol so colour never carries meaning
  // alone. Black text and symbols pass 7:1 on all of them.
  const COLOURS = [
    { name: 'green', hex: '#81ff73', symbol: '●' },
    { name: 'pink', hex: '#f273ff', symbol: '▲' },
    { name: 'blue', hex: '#73f2ff', symbol: '■' },
    { name: 'yellow', hex: '#fff273', symbol: '◆' },
    { name: 'violet', hex: '#a9b1ff', symbol: '★' },
    { name: 'orange', hex: '#ffb57a', symbol: '✚' },
    { name: 'red', hex: '#ff8f8f', symbol: '♥' },
    { name: 'lime', hex: '#d4ff5c', symbol: '▼' },
    { name: 'grey', hex: '#d0d0d0', symbol: '◐' },
    { name: 'brown', hex: '#d9b48f', symbol: '✱' },
  ];

  // In the order the device menu shows them. sound: plays notes on its own
  // channel. uses 'mod': changes another device's sound.
  const DEVICES = {
    notes: { name: 'notes', what: 'Each switch plays a note.', sound: true },
    gen: { name: 'melody generator', what: 'Makes up a new note on every press: a tune that wanders, comes home and changes a little.', uses: 'gen', sound: true },
    seq: { name: 'sequencer', what: 'Plays a tune: one note per press, or by itself in time.', uses: 'seq', sound: true },
    arp: { name: 'arpeggiator', what: 'Plays the notes of a chord one after another, in time.', uses: 'seq', sound: true },
    lfo: { name: 'wobble', sub: 'LFO', what: 'Moves a sound up and down, over and over.', uses: 'mod' },
    env: { name: 'swell', sub: 'envelope', what: 'Makes a sound rise and fall, once each time.', uses: 'mod' },
    controls: { name: 'controls', what: 'Shifts everyone up or down, or changes template.' },
  };
  const KINDS = Object.keys(DEVICES);
  const isSound = (d) => !!DEVICES[d.kind].sound;
  const isMod = (d) => DEVICES[d.kind].uses === 'mod';

  // Controls, most useful first: [key, label, semitones or null].
  const CONTROL_ROLES = [
    ['up', 'octave up', 12], ['down', 'octave down', -12],
    ['sup', 'semitone up', 1], ['sdown', 'semitone down', -1],
    ['next', 'next template', null],
  ];

  // A device's jobs as [key, label], in priority order: a new switch takes
  // the first job that's free, so one switch always makes a sound.
  function roles(band, d) {
    switch (d.kind) {
      case 'seq':
        return band.sequences[d.seq].mode === 'press'
          ? [['step', 'next note'], ['restart', 'back to the start']]
          : [['play', 'play'], ['restart', 'back to the start']];
      case 'arp': return [['play', 'play']];
      case 'gen': return [['note', 'new note'], ['home', 'home'], ['again', 'again'], ['new', 'new tune']];
      case 'lfo': return [['run', 'wobble'], ['stop', 'stop it']];
      case 'env': return [['run', 'swell']];
      case 'controls': return CONTROL_ROLES.map(([k, label]) => [k, label]);
      default: return [];
    }
  }

  // --- Octaves ---
  // Every device plays in the template's key. Notes, sequencers, arpeggiators
  // and melody generators that use scale notes can sit higher or lower by
  // whole octaves (d.octave, -2 to 2). The board knows nothing of this: the
  // shift is applied to the notes when the table is built, and taken off
  // again when a table is read back.

  const OCTAVES = [-2, -1, 0, 1, 2];
  // Scale steps in an octave of the template's scale.
  const scaleLength = (mask) => { let n = 0; for (let b = 0; b < 12; b++) if (mask & (1 << b)) n++; return n || 7; };

  // Whether a device's octave setting applies (scale notes only: fixed
  // notes and drums stay where they are).
  function usesOctave(band, d) {
    if (d.kind === 'notes') return d.noteType === 'scale';
    if (d.kind === 'seq' || d.kind === 'arp') return band.sequences[d.seq].noteType === 'scale';
    return d.kind === 'gen';
  }

  // The device's shift in scale steps.
  const octaveSteps = (band, d) => (usesOctave(band, d) ? (d.octave || 0) * scaleLength(band.mask) : 0);

  // Shifts a sequence's notes or a generator's range by n scale steps.
  const shiftSequence = (q, n) => ({ ...q, notes: q.notes.map((x) => (x === null ? null : x + n)) });
  const shiftGenerator = (g, n) => ({ ...g, low: g.low + n, high: g.high + n, home: g.home + n });

  // --- Making bands ---

  const defaultAccess = () => ({ label: '', lockoutMs: 0, holdMs: DEFAULT_HOLD_MS });

  function defaultBand() {
    const f = S.defaultForm();
    delete f.switches;
    f.name = 'Band';
    // New bands keep their own tempo; following an external MIDI clock is
    // opt-in. (The firmware's built-in table still follows the clock.)
    f.ignoreClock = true;
    f.devices = [];
    f.access = Array.from({ length: S.NUM_INPUTS }, defaultAccess);
    return f;
  }

  const idsInUse = (band, key) => new Set(band.devices.filter((d) => d[key] !== undefined).map((d) => d[key]));
  const seqIdsInUse = (band) => idsInUse(band, 'seq');
  const modIdsInUse = (band) => idsInUse(band, 'mod');
  const genIdsInUse = (band) => idsInUse(band, 'gen');

  // Bands saved before generators existed have none.
  function generatorsOf(band) {
    if (!band.generators) band.generators = Array.from({ length: NUM_GENS }, S.defaultGenerator);
    return band.generators;
  }

  function freeId(used, n) {
    for (let id = 0; id < n; id++) if (!used.has(id)) return id;
    return null;
  }

  // Whether a device of this kind can be added (the board has 4 sequences,
  // 4 modulators and 4 generators).
  function canAdd(band, kind) {
    const uses = DEVICES[kind].uses;
    if (uses === 'seq') return freeId(seqIdsInUse(band), NUM_SEQS) !== null;
    if (uses === 'mod') return freeId(modIdsInUse(band), NUM_MODS) !== null;
    if (uses === 'gen') return freeId(genIdsInUse(band), NUM_GENS) !== null;
    return true;
  }

  // The least-used colour, so neighbours differ.
  function nextColour(band) {
    const count = COLOURS.map((_, i) => band.devices.filter((d) => d.colour === i).length);
    return count.indexOf(Math.min(...count));
  }

  // A channel no other sound device has, so a DAW can give each one a
  // sound. Channel 10 (9 here) is drums, so it's skipped.
  function freeChannel(band) {
    const used = new Set(band.devices.filter(isSound).map((d) => d.channel));
    for (let ch = 0; ch < 16; ch++) if (ch !== 9 && !used.has(ch)) return ch;
    return 0;
  }

  // A new device, given the chosen switches in order. Returns {device, left}
  // (left: switches it had no job for), or null if the board has no room.
  function newDevice(band, kind, inputs = []) {
    if (!canAdd(band, kind)) return null;
    const d = { kind, name: '', colour: nextColour(band), collapsed: false, switches: [] };
    if (isSound(d)) Object.assign(d, { channel: freeChannel(band), velocity: 100, octave: 0 });
    if (kind === 'notes') {
      Object.assign(d, { noteType: 'scale', gate: 'hold' });
    } else if (kind === 'seq' || kind === 'arp') {
      const id = freeId(seqIdsInUse(band), NUM_SEQS);
      band.sequences[id] = kind === 'seq'
        ? { ...S.defaultSequence(), mode: 'press', noteType: 'scale', notes: [0, 1, 2, 3, 4, 3, 2, 1], gate: 0 }
        : { ...S.defaultSequence(), mode: 'clock', noteType: 'scale', notes: [0, 2, 4], order: 'up', octaves: 2, division: 6, gate: 70 };
      Object.assign(d, { seq: id, gate: kind === 'arp' ? 'hold' : 'latch', onBeat: kind !== 'arp' });
    } else if (kind === 'lfo' || kind === 'env') {
      const id = freeId(modIdsInUse(band), NUM_MODS);
      band.modulators[id] = kind === 'lfo'
        ? { ...S.defaultModulator('lfo'), cc: 74, from: 20, to: 110 }
        : { ...S.defaultModulator('env'), cc: 74, from: 10, to: 127, exponential: true };
      // It changes the newest sound device, if there is one.
      const sounds = band.devices.filter(isSound);
      const target = sounds.length ? sounds[sounds.length - 1] : null;
      Object.assign(d, { mod: id, gate: kind === 'lfo' ? 'latch' : 'hold', onBeat: false, target, channel: target ? target.channel : 0 });
    } else if (kind === 'gen') {
      const id = freeId(genIdsInUse(band), NUM_GENS);
      generatorsOf(band)[id] = { ...S.defaultGenerator(), on: true };
      Object.assign(d, { gen: id, gate: 'hold', onBeat: false });
    }
    band.devices.push(d);
    const left = inputs.filter((input) => !addSwitch(band, d, input));
    return { device: d, left };
  }

  // Removes a device; its sequence, modulator or generator is cleared, and
  // wobbles that changed it keep changing its channel.
  function removeDevice(band, d) {
    band.devices = band.devices.filter((x) => x !== d);
    if (d.seq !== undefined && !seqIdsInUse(band).has(d.seq)) {
      band.sequences[d.seq] = S.defaultSequence();
      for (const mod of band.modulators) if (mod.follow === d.seq) mod.follow = null;
    }
    if (d.mod !== undefined && !modIdsInUse(band).has(d.mod)) band.modulators[d.mod] = S.defaultModulator();
    if (d.gen !== undefined && !genIdsInUse(band).has(d.gen)) generatorsOf(band)[d.gen] = S.defaultGenerator();
    for (const x of band.devices) if (x.target === d) Object.assign(x, { target: null, channel: d.channel });
  }

  // A sequencer switching between "one note per press" and "by itself":
  // its next-note switch becomes its play switch, and back.
  function setSequenceMode(band, id, mode) {
    band.sequences[id].mode = mode;
    for (const d of band.devices) {
      if (d.kind !== 'seq' || d.seq !== id) continue;
      for (const s of d.switches) {
        if (mode === 'clock' && s.role === 'step') s.role = 'play';
        else if (mode === 'press' && s.role === 'play') s.role = 'step';
      }
    }
  }

  // --- Switches ---

  // Every switch in use: [{input, device, role} or {input, device, value}].
  function slots(band) {
    const out = [];
    for (const d of band.devices) for (const s of d.switches) out.push({ ...s, device: d });
    return out;
  }

  function owner(band, input) {
    return slots(band).find((s) => s.input === input) || null;
  }

  // Frees a switch from whichever device has it; returns where it was, or null.
  function release(band, input) {
    const was = owner(band, input);
    if (was) was.device.switches = was.device.switches.filter((s) => s.input !== input);
    return was;
  }

  function freeInputs(band) {
    const used = new Set(slots(band).map((s) => s.input));
    return Array.from({ length: NUM_SWITCHES }, (_, i) => i).filter((i) => !used.has(i));
  }

  // The jobs a device has no switch for yet, in priority order.
  function freeRoles(band, d) {
    if (d.kind === 'notes') return [];
    return roles(band, d).filter(([k]) => !d.switches.some((s) => s.role === k));
  }

  // Whether the device can take another switch.
  function hasRoom(band, d) {
    return d.kind === 'notes' ? d.switches.length < S.NUM_INPUTS : freeRoles(band, d).length > 0;
  }

  // The note a notes device's next switch plays: up the scale from the last
  // one, or the next drum.
  function nextNoteValue(d) {
    const last = d.switches.length ? d.switches[d.switches.length - 1].value : null;
    const drums = d.channel === 9;
    if (d.noteType === 'scale') return last === null ? 0 : Math.min(last + 1, 14);
    if (last === null) return drums ? 36 : 60;
    return Math.min(last + (drums ? 1 : 2), drums ? 81 : 96);
  }

  // Gives a device a switch: a note, or its first free job. The switch
  // leaves any other device first. Returns {was} (where it was, or null),
  // or null if the device has no job left for it.
  function addSwitch(band, d, input) {
    if (d.switches.some((s) => s.input === input)) return { was: null };
    if (!hasRoom(band, d)) return null;
    const was = release(band, input);
    if (d.kind === 'notes') d.switches.push({ input, value: nextNoteValue(d) });
    else d.switches.push({ input, role: freeRoles(band, d)[0][0] });
    return { was };
  }

  function removeSwitch(band, d, input) {
    d.switches = d.switches.filter((s) => s.input !== input);
  }

  // Gives a switch another job; the switch that had it swaps.
  function setRole(band, d, input, role) {
    const me = d.switches.find((s) => s.input === input);
    if (!me || me.role === role) return;
    const other = d.switches.find((s) => s.role === role);
    if (other) other.role = me.role;
    me.role = role;
  }

  // --- Band -> form -> table ---

  // The channel a device plays or changes: a wobble's target's, or its own.
  const channelOf = (band, d) => (d.target && band.devices.includes(d.target) ? d.target.channel : d.channel);

  // The form the rule table is built from: one action per switch.
  function toForm(band) {
    const f = {
      ...band,
      switches: Array.from({ length: S.NUM_INPUTS }, () => ({ action: 'none' })),
      sequences: band.sequences.map((q) => ({ ...q })),
      modulators: band.modulators.map((m) => ({ ...m })),
      generators: generatorsOf(band).map((g) => ({ ...g })),
    };
    delete f.devices;
    delete f.access;
    delete f.inputs;  // tableFromBand works it out
    const seqs = new Set();
    const mods = new Set();
    const gens = new Set();
    for (const d of band.devices) {
      const valid = new Set(roles(band, d).map(([k]) => k));
      const set = (role, action) => {
        if (!valid.has(role)) return;
        for (const s of d.switches) if (s.role === role) f.switches[s.input] = action;
      };
      if (d.kind === 'notes') {
        const up = octaveSteps(band, d);
        for (const s of d.switches)
          f.switches[s.input] = d.noteType === 'scale'
            ? { action: 'scale', degree: s.value + up, gate: d.gate, channel: d.channel, velocity: d.velocity }
            : { action: 'note', note: s.value, gate: d.gate, channel: d.channel, velocity: d.velocity };
      } else if (d.kind === 'seq' || d.kind === 'arp') {
        if (!seqs.has(d.seq)) {
          f.sequences[d.seq] = { ...shiftSequence(f.sequences[d.seq], octaveSteps(band, d)), channel: d.channel, velocity: d.velocity };
        }
        seqs.add(d.seq);
        set('play', { action: 'seq-play', seq: d.seq, gate: d.gate, onBeat: !!d.onBeat });
        set('step', { action: 'seq-step', seq: d.seq });
        set('restart', { action: 'seq-restart', seq: d.seq });
      } else if (d.kind === 'lfo' || d.kind === 'env') {
        if (!mods.has(d.mod)) f.modulators[d.mod].channel = channelOf(band, d);
        mods.add(d.mod);
        set('run', { action: 'mod-run', mod: d.mod, gate: d.gate, onBeat: !!d.onBeat });
        set('stop', { action: 'mod-stop', mod: d.mod });
      } else if (d.kind === 'gen') {
        if (!gens.has(d.gen)) {
          f.generators[d.gen] = { ...shiftGenerator(f.generators[d.gen], octaveSteps(band, d)), on: true, channel: d.channel, velocity: d.velocity };
        }
        gens.add(d.gen);
        const sounding = { gen: d.gen, gate: d.gate, onBeat: !!d.onBeat };
        set('note', { action: 'gen-note', ...sounding });
        set('home', { action: 'gen-home', ...sounding });
        set('again', { action: 'gen-again', ...sounding });
        set('new', { action: 'gen-new', gen: d.gen });
      } else if (d.kind === 'controls') {
        for (const [key, , semitones] of CONTROL_ROLES)
          set(key, semitones === null ? { action: 'preset-next' } : { action: 'transpose', semitones });
      }
    }
    // Sequences and modulators no device uses aren't sent to the board.
    for (let id = 0; id < NUM_SEQS; id++) if (!seqs.has(id)) f.sequences[id] = { ...f.sequences[id], notes: [] };
    for (let id = 0; id < NUM_MODS; id++) if (!mods.has(id)) f.modulators[id] = { ...f.modulators[id], kind: 'off' };
    for (let id = 0; id < NUM_GENS; id++) if (!gens.has(id)) f.generators[id] = { ...f.generators[id], on: false };
    return f;
  }

  // The devices and switch settings as stored in the EDITOR section:
  // everything except the sequences' notes and the modulators' shapes,
  // which the table holds.
  function editorJson(band) {
    const access = [];
    band.access.forEach((a, i) => {
      if (a.label || a.lockoutMs || a.holdMs !== DEFAULT_HOLD_MS) access.push([i, a.label, a.lockoutMs, a.holdMs]);
    });
    return {
      v: EDITOR_VERSION,
      d: band.devices.map((d) => {
        const out = { k: d.kind, c: d.colour, sw: d.switches.map((s) => [s.input, d.kind === 'notes' ? s.value : s.role]) };
        if (d.name) out.n = d.name;
        if (d.collapsed) out.f = 1;
        if (d.channel !== undefined) out.ch = d.channel;
        if (d.velocity !== undefined) out.v = d.velocity;
        if (d.octave) out.oc = d.octave;
        if (d.kind === 'notes') out.t = d.noteType;
        if (d.seq !== undefined) out.s = d.seq;
        if (d.mod !== undefined) out.o = d.mod;
        if (d.gen !== undefined) out.x = d.gen;
        if (d.gate !== undefined) out.g = d.gate;
        if (d.onBeat) out.b = 1;
        if (d.target && band.devices.includes(d.target)) out.to = band.devices.indexOf(d.target);
        return out;
      }),
      ...(access.length ? { a: access } : {}),
      // Generator settings travel here too, so they survive on a board whose
      // firmware (before 0.8.0) can't take GENERATOR sections.
      ...(genIdsInUse(band).size ? {
        gen: Object.fromEntries([...genIdsInUse(band)].map((id) => {
          const { on, channel, velocity, ...settings } = generatorsOf(band)[id];
          return [id, settings];
        })),
      } : {}),
    };
  }

  function editorSection(band) {
    const body = Array.from(new TextEncoder().encode(JSON.stringify(editorJson(band))));
    return [EDITOR_ID, 0, body.length & 0xff, (body.length >> 8) & 0xff, ...body];
  }

  // Each switch's lockout and hold time. Returns {lockout, hold} (the shared
  // values, or the longest) and, if the switches in use differ,
  // {perInput: {lockout: [12], hold: [12]}}.
  function inputSettings(band) {
    const used = slots(band).map((s) => band.access[s.input]);
    const ls = used.map((a) => a.lockoutMs);
    const hs = used.map((a) => a.holdMs);
    const out = { lockout: Math.max(0, ...ls), hold: hs.length ? Math.max(...hs) : DEFAULT_HOLD_MS };
    if (new Set(ls).size > 1 || new Set(hs).size > 1)
      out.perInput = { lockout: band.access.map((a) => a.lockoutMs), hold: band.access.map((a) => a.holdMs) };
    return out;
  }

  // perInput: the board takes each switch's own settings (firmware 0.7.0 and
  // later). Otherwise every switch gets the longest lockout and hold time.
  // generators: the board takes GENERATOR sections (firmware 0.8.0 and
  // later). Otherwise generators are left out of the table (the page plays
  // them itself) but still kept in the EDITOR section.
  function tableFromBand(band, { perInput = true, generators = true } = {}) {
    const f = toForm(band);
    if (!generators) {
      f.generators = f.generators.map((g) => ({ ...g, on: false }));
      f.switches = f.switches.map((s) => (s.action.startsWith('gen-') ? { action: 'none' } : s));
    }
    const settings = inputSettings(band);
    Object.assign(f, { lockoutMs: settings.lockout, holdMs: settings.hold });
    if (settings.perInput && perInput) f.inputs = settings.perInput;
    const table = S.tableFromForm(f);
    const editor = editorSection(band);
    // The devices only go along if there's room; without them the preset
    // still plays, and reopens with a device per kind of switch.
    table.extra = S.buildTable(table).length + editor.length <= MAX_TABLE_LEN ? [editor] : [];
    return table;
  }

  // --- Table -> band ---

  const isInput = (v) => Number.isInteger(v) && v >= 0 && v < S.NUM_INPUTS;
  const isChannel = (v) => Number.isInteger(v) && v >= 0 && v <= 15;
  const GATES = ['hold', 'latch', 'oneshot'];

  function parseEditor(section) {
    try {
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(section.slice(4))));
    } catch (e) {
      return null;
    }
  }

  // {devices, access} from an EDITOR section, checked; null if unusable
  // (including the older musician format, which then opens from the rules).
  function readEditor(data, form) {
    if (!data || data.v !== EDITOR_VERSION || !Array.isArray(data.d)) return null;
    const devices = [];
    const targets = [];
    const seen = new Set();
    for (const x of data.d) {
      if (!x || !KINDS.includes(x.k) || !Number.isInteger(x.c) || x.c < 0 || x.c >= COLOURS.length || !Array.isArray(x.sw)) return null;
      const info = DEVICES[x.k];
      const d = { kind: x.k, name: typeof x.n === 'string' ? x.n.slice(0, 24) : '', colour: x.c, collapsed: x.f === 1, switches: [] };
      if (info.sound || info.uses === 'mod') {
        if (!isChannel(x.ch)) return null;
        d.channel = x.ch;
      }
      if (info.sound) {
        d.velocity = Number.isInteger(x.v) && x.v >= 1 && x.v <= 127 ? x.v : 100;
        d.octave = OCTAVES.includes(x.oc) ? x.oc : 0;
      }
      if (x.k === 'notes') {
        if (!['scale', 'fixed'].includes(x.t)) return null;
        d.noteType = x.t;
      }
      const okId = (key, n) => Number.isInteger(x[key]) && x[key] >= 0 && x[key] < n;
      if (info.uses === 'seq') { if (!okId('s', NUM_SEQS)) return null; d.seq = x.s; }
      if (info.uses === 'mod') { if (!okId('o', NUM_MODS)) return null; d.mod = x.o; }
      if (info.uses === 'gen') { if (!okId('x', NUM_GENS)) return null; d.gen = x.x; }
      if (x.k !== 'controls') {
        d.gate = GATES.includes(x.g) ? x.g : 'hold';
        if (x.k !== 'notes') d.onBeat = !!x.b;
      }
      for (const s of x.sw) {
        if (!Array.isArray(s) || !isInput(s[0]) || seen.has(s[0])) return null;
        seen.add(s[0]);
        if (x.k === 'notes') {
          if (!Number.isInteger(s[1])) return null;
          d.switches.push({ input: s[0], value: s[1] });
        } else {
          if (typeof s[1] !== 'string') return null;
          d.switches.push({ input: s[0], role: s[1] });
        }
      }
      targets.push(info.uses === 'mod' && Number.isInteger(x.to) ? x.to : null);
      devices.push(d);
    }
    devices.forEach((d, i) => {
      if (d.mod === undefined) return;
      const t = targets[i] === null ? null : devices[targets[i]];
      d.target = t && isSound(t) ? t : null;
    });
    // Each switch's job must be one its device has.
    const probe = { ...form, devices };
    for (const d of devices) {
      const valid = new Set(roles(probe, d).map(([k]) => k));
      if (d.kind !== 'notes' && d.switches.some((s) => !valid.has(s.role))) return null;
    }
    const access = accessFromForm(form);
    for (const a of Array.isArray(data.a) ? data.a : []) {
      if (!Array.isArray(a) || !isInput(a[0])) continue;
      access[a[0]] = {
        label: typeof a[1] === 'string' ? a[1].slice(0, MAX_LABEL) : '',
        lockoutMs: Number.isInteger(a[2]) && a[2] >= 0 && a[2] <= 60000 ? a[2] : 0,
        holdMs: Number.isInteger(a[3]) && a[3] >= 1 && a[3] <= 60000 ? a[3] : DEFAULT_HOLD_MS,
      };
    }
    return { devices, access };
  }

  // Rules in a comparable form (built rules leave zero fields out).
  const ruleKey = (r) => [r.trig, r.src || 0, r.arg || 0, r.act, r.flags || 0, r.p0 || 0, r.p1 || 0,
    r.p2 || 0, r.p3 || 0].join(',');
  // Generator rules are left out when comparing: an older board's table has
  // none even though the band has generators (tableFromBand).
  const notGen = (r) => r.act < S.ACT.GEN_NOTE || r.act > 0x5f;

  // Generator settings kept in the EDITOR section: {id: settings}, checked.
  function readEditorGenerators(data) {
    const out = {};
    const fields = Object.keys(S.defaultGenerator()).filter((k) => k !== 'on');
    for (const [id, g] of Object.entries((data && data.gen) || {})) {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 0 || n >= NUM_GENS || !g || typeof g !== 'object') continue;
      const ok = fields.every((k) => (k === 'gapFill' ? typeof g[k] === 'boolean' : Number.isInteger(g[k])));
      if (ok) out[n] = Object.fromEntries(fields.map((k) => [k, g[k]]));
    }
    return out;
  }

  // Access settings from the table: per switch if it has an INPUTS section,
  // otherwise the shared values.
  function accessFromForm(form) {
    return Array.from({ length: S.NUM_INPUTS }, (_, i) => ({
      label: '',
      lockoutMs: form.inputs ? form.inputs.lockout[i] : form.lockoutMs || 0,
      holdMs: form.inputs ? form.inputs.hold[i] : form.holdMs || DEFAULT_HOLD_MS,
    }));
  }

  // Returns {band} or {reason} if the table uses things this editor can't show.
  function bandFromTable(table) {
    const extra = table.extra || [];
    const editor = extra.find((s) => s[0] === EDITOR_ID);
    const result = S.formFromTable({ ...table, extra: extra.filter((s) => s[0] !== EDITOR_ID) });
    if (!result.form) return { reason: result.reason };
    const form = result.form;
    if (editor) {
      const data = parseEditor(editor);
      const read = readEditor(data, form);
      if (read) {
        const band = { ...form, devices: read.devices, access: read.access };
        delete band.switches;
        delete band.inputs;
        // Generators the table doesn't hold (an older board) take their
        // settings from the EDITOR section.
        const stored = readEditorGenerators(data);
        const gens = generatorsOf(band);
        const seqsDone = new Set();
        const gensDone = new Set();
        for (const d of band.devices) {
          // The table holds notes shifted by the device's octave (toForm).
          const n = octaveSteps(band, d);
          if (d.seq !== undefined && !seqsDone.has(d.seq)) {
            seqsDone.add(d.seq);
            if (n) band.sequences[d.seq] = shiftSequence(band.sequences[d.seq], -n);
          }
          if (d.kind !== 'gen' || gensDone.has(d.gen)) continue;
          gensDone.add(d.gen);
          if (gens[d.gen].on) {
            if (n) gens[d.gen] = shiftGenerator(gens[d.gen], -n);
          } else {
            gens[d.gen] = stored[d.gen] ? { ...stored[d.gen], on: true } : { ...S.defaultGenerator(), on: true };
          }
        }
        // Use the stored devices only if they still make the same rules
        // (another tool may have changed the table since).
        const rules = S.tableFromForm(toForm(band)).rules.filter(notGen).map(ruleKey).join(';');
        if (rules === table.rules.filter(notGen).map(ruleKey).join(';')) return { band };
      }
    }
    return { band: bandFromForm(form) };
  }

  // A form (an older preset, or one without stored devices) as a band: a
  // device for each kind of switch, grouped by channel.
  function bandFromForm(form) {
    const band = { ...form, devices: [], access: accessFromForm(form) };
    delete band.switches;
    delete band.inputs;
    const add = (d) => {
      Object.assign(d, { name: '', colour: band.devices.length % COLOURS.length, collapsed: false });
      band.devices.push(d);
      return d;
    };
    // A device of a kind (and sequence, modulator or generator) whose role
    // is free, or a new one.
    const deviceFor = (kind, extra, role, gate, onBeat) => {
      let d = band.devices.find((x) => x.kind === kind && Object.entries(extra).every(([k, v]) => x[k] === v) &&
        !x.switches.some((s) => s.role === role) &&
        (gate === undefined || x.gate === undefined || (x.gate === gate && x.onBeat === !!onBeat)));
      if (!d) {
        d = add({ kind, ...extra, switches: [] });
        if (kind !== 'controls') Object.assign(d, { gate: gate || 'hold', onBeat: !!onBeat });
      }
      if (gate !== undefined && d.gate !== undefined) Object.assign(d, { gate, onBeat: !!onBeat });
      return d;
    };
    const seqKind = (id, hasStep) => {
      const q = form.sequences[id];
      return q.mode === 'clock' && q.order !== 'written' && q.noteType === 'scale' && !hasStep ? 'arp' : 'seq';
    };
    const stepped = new Set(form.switches.filter((s) => s.action === 'seq-step' || s.action === 'seq-restart').map((s) => s.seq));
    const ch = (c) => (c === undefined || c === null ? form.channel : c);

    form.switches.forEach((s, input) => {
      if (s.action === 'scale' || s.action === 'note') {
        const noteType = s.action === 'scale' ? 'scale' : 'fixed';
        const channel = ch(s.channel);
        const velocity = s.velocity || form.velocity;
        let d = band.devices.find((x) => x.kind === 'notes' && x.noteType === noteType && x.gate === s.gate &&
          x.channel === channel && x.velocity === velocity);
        if (!d) d = add({ kind: 'notes', noteType, gate: s.gate, channel, velocity, switches: [] });
        d.switches.push({ input, value: noteType === 'scale' ? s.degree : s.note });
      } else if (s.action.startsWith('seq-')) {
        const q = form.sequences[s.seq];
        const role = { 'seq-play': 'play', 'seq-step': 'step', 'seq-restart': 'restart' }[s.action];
        // A press-mode sequence is stepped; a clock one is played.
        const fixedRole = q.mode === 'press' && role === 'play' ? 'step' : q.mode === 'clock' && role === 'step' ? 'play' : role;
        const kind = seqKind(s.seq, stepped.has(s.seq));
        const d = s.action === 'seq-play'
          ? deviceFor(kind, { seq: s.seq }, fixedRole, s.gate, s.onBeat)
          : deviceFor(kind, { seq: s.seq }, fixedRole);
        d.switches.push({ input, role: fixedRole });
      } else if (s.action.startsWith('mod-')) {
        const kind = form.modulators[s.mod].kind === 'env' ? 'env' : 'lfo';
        const role = s.action === 'mod-run' ? 'run' : 'stop';
        const d = s.action === 'mod-run'
          ? deviceFor(kind, { mod: s.mod }, role, s.gate, s.onBeat)
          : deviceFor(kind, { mod: s.mod }, role);
        d.switches.push({ input, role });
      } else if (s.action.startsWith('gen-')) {
        const role = { 'gen-note': 'note', 'gen-home': 'home', 'gen-again': 'again', 'gen-new': 'new' }[s.action];
        const d = s.action === 'gen-new'
          ? deviceFor('gen', { gen: s.gen }, role)
          : deviceFor('gen', { gen: s.gen }, role, s.gate, s.onBeat);
        d.switches.push({ input, role });
      } else if (s.action === 'transpose' || s.action === 'preset-next') {
        let key = 'next';
        if (s.action === 'transpose') {
          const big = Math.abs(s.semitones) >= 7;
          key = s.semitones < 0 ? (big ? 'down' : 'sdown') : (big ? 'up' : 'sup');
        }
        deviceFor('controls', {}, key).switches.push({ input, role: key });
      }
    });
    // Sequences, modulators and generators with no switch (an envelope that
    // follows a sequence, say) still get a device, so they aren't lost.
    form.sequences.forEach((q, id) => {
      if (q.notes.length && !seqIdsInUse(band).has(id)) deviceFor(seqKind(id, false), { seq: id }, 'play', 'hold', false);
    });
    form.modulators.forEach((mod, id) => {
      if (mod.kind !== 'off' && !modIdsInUse(band).has(id)) deviceFor(mod.kind, { mod: id }, 'run', 'hold', false);
    });
    generatorsOf(form).forEach((g, id) => {
      if (g.on && !genIdsInUse(band).has(id)) deviceFor('gen', { gen: id }, 'note', 'hold', false);
    });
    // Channels and loudness from the sequences and generators.
    for (const d of band.devices) {
      if (d.seq !== undefined)
        Object.assign(d, { channel: ch(form.sequences[d.seq].channel), velocity: form.sequences[d.seq].velocity || form.velocity });
      if (d.gen !== undefined) {
        const g = generatorsOf(form)[d.gen];
        Object.assign(d, { channel: ch(g.channel), velocity: g.velocity || form.velocity });
      }
    }
    for (const d of band.devices) if (isSound(d)) d.octave = 0;
    // A wobble changes the sound device on its channel, if there is one.
    for (const d of band.devices) {
      if (d.mod === undefined) continue;
      d.channel = ch(form.modulators[d.mod].channel);
      d.target = band.devices.find((x) => isSound(x) && x.channel === d.channel) || null;
    }
    return band;
  }

  // --- Templates ---
  // Each returns a fresh band. Names fit the board's 16 characters.

  // A clean slate: no devices. The two analog inputs send CC 20 and 21,
  // which MIDI leaves undefined, so they change nothing in a DAW until
  // they're mapped.
  const BLANK_CCS = [20, 21];
  function blankBand() {
    const b = defaultBand();
    b.name = 'Empty';
    b.analog = BLANK_CCS.map((cc) => ({ cc }));
    return b;
  }

  const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const TEMPLATES = [
    {
      id: 'scale', name: 'Scale player',
      description: 'Switches 1–10 play up the scale.',
      band: () => {
        const b = defaultBand();
        b.name = 'Scale player';
        newDevice(b, 'notes', range(0, NUM_SWITCHES));
        return b;
      },
    },
  ];

  global.SwitchcraftBand = {
    COLOURS, DEVICES, KINDS, NUM_SWITCHES, NUM_SEQS, NUM_MODS, NUM_GENS, TEMPLATES, EDITOR_ID, DEFAULT_HOLD_MS, MAX_LABEL,
    roles, freeRoles, hasRoom, isSound, isMod, channelOf, OCTAVES, usesOctave, octaveSteps, scaleLength,
    defaultBand, blankBand, newDevice, removeDevice, canAdd, setSequenceMode,
    slots, owner, release, freeInputs, addSwitch, removeSwitch, setRole,
    seqIdsInUse, modIdsInUse, genIdsInUse, generatorsOf,
    toForm, tableFromBand, bandFromTable, bandFromForm, editorJson, inputSettings,
  };
})(typeof window !== 'undefined' ? window : globalThis);
