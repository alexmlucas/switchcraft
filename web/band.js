// band.js: the model behind the musician view (no page code).
//
// A band is the form model from switchcraft.js (key, tempo, analog inputs,
// sequences A-D, modulators 1-4) plus a list of musicians. Each musician has
// a name, a colour and a MIDI channel, and plays one or more devices: notes,
// a sequencer, an arpeggiator, a wobble (LFO), a swell (envelope) or
// controls. A device has a few roles, such as "play" or "next note", and
// each role is filled by one switch.
//
// The band compiles to the same rule table as the form. The musicians'
// names, colours and devices travel with it in the table's EDITOR section
// (spec B.7), which the firmware stores but never reads, so a preset read
// back from the board reopens with its musicians.
(function (global) {
  'use strict';

  const S = global.Switchcraft;
  const EDITOR_ID = 0x10;
  const EDITOR_VERSION = 1;
  const MAX_TABLE_LEN = 4080;
  const MAX_MUSICIANS = 6;
  const NUM_SEQS = 4;
  const NUM_MODS = 4;

  // Soft brand colours, each with a symbol so colour never carries meaning
  // alone. Black text and symbols pass 7:1 on all of them.
  const COLOURS = [
    { name: 'green', hex: '#81ff73', symbol: '●' },
    { name: 'pink', hex: '#f273ff', symbol: '▲' },
    { name: 'blue', hex: '#73f2ff', symbol: '■' },
    { name: 'yellow', hex: '#fff273', symbol: '◆' },
    { name: 'violet', hex: '#a9b1ff', symbol: '★' },
    { name: 'orange', hex: '#ffb57a', symbol: '✚' },
  ];

  const DEVICES = {
    notes: { name: 'notes', what: 'Each switch plays a note.' },
    seq: { name: 'sequencer', what: 'Plays a tune: one note per press, or by itself in time.', uses: 'seq' },
    arp: { name: 'arpeggiator', what: 'Plays the notes of a chord one after another, in time.', uses: 'seq' },
    lfo: { name: 'wobble', sub: 'LFO', what: 'Moves a sound up and down, over and over.', uses: 'mod' },
    env: { name: 'swell', sub: 'envelope', what: 'Makes a sound rise and fall, once each time.', uses: 'mod' },
    controls: { name: 'controls', what: 'Shifts everyone up or down, or changes preset.' },
  };
  const KINDS = Object.keys(DEVICES);

  const CONTROL_ROLES = [
    ['down', 'octave down', -12], ['up', 'octave up', 12],
    ['sdown', 'semitone down', -1], ['sup', 'semitone up', 1],
    ['next', 'next preset', null],
  ];

  // The roles a device's switches can fill, as [key, label]. A sequencer's
  // roles depend on how its sequence plays.
  function roles(band, d) {
    switch (d.kind) {
      case 'seq':
        return band.sequences[d.seq].mode === 'press'
          ? [['step', 'next note'], ['restart', 'back to the start']]
          : [['play', 'play'], ['restart', 'back to the start']];
      case 'arp': return [['play', 'play']];
      case 'lfo': return [['run', 'wobble'], ['stop', 'stop it']];
      case 'env': return [['run', 'swell']];
      case 'controls': return CONTROL_ROLES.map(([k, label]) => [k, label]);
      default: return [];
    }
  }

  // --- Making bands ---

  function defaultBand() {
    const f = S.defaultForm();
    delete f.switches;
    f.name = 'Band';
    f.musicians = [];
    return f;
  }

  function seqIdsInUse(band) {
    const ids = new Set();
    for (const m of band.musicians) for (const d of m.devices) if (DEVICES[d.kind].uses === 'seq') ids.add(d.seq);
    return ids;
  }

  function modIdsInUse(band) {
    const ids = new Set();
    for (const m of band.musicians) for (const d of m.devices) if (DEVICES[d.kind].uses === 'mod') ids.add(d.mod);
    return ids;
  }

  function freeId(used, n) {
    for (let id = 0; id < n; id++) if (!used.has(id)) return id;
    return null;
  }

  // Whether a device of this kind can be added (the board has 4 sequences
  // and 4 modulators).
  function canAdd(band, kind) {
    const uses = DEVICES[kind].uses;
    if (uses === 'seq') return freeId(seqIdsInUse(band), NUM_SEQS) !== null;
    if (uses === 'mod') return freeId(modIdsInUse(band), NUM_MODS) !== null;
    return true;
  }

  function addMusician(band, name) {
    if (band.musicians.length >= MAX_MUSICIANS) return null;
    const colours = new Set(band.musicians.map((m) => m.colour));
    const channels = new Set(band.musicians.map((m) => m.channel));
    let colour = 0;
    while (colours.has(colour) && colour < COLOURS.length - 1) colour++;
    // Their own channel, so a DAW can give each musician a sound. Channel 10
    // (9 here) is drums, so it's skipped.
    let channel = 0;
    while ((channels.has(channel) || channel === 9) && channel < 15) channel++;
    const m = { name: name || `Musician ${band.musicians.length + 1}`, colour, channel, devices: [] };
    band.musicians.push(m);
    return m;
  }

  // Adds a device that makes a sound straight away once a switch is set,
  // or returns null if the board has no room for it.
  function addDevice(band, m, kind) {
    if (!canAdd(band, kind)) return null;
    let d;
    if (kind === 'notes') {
      d = { kind, noteType: 'scale', gate: 'hold', keys: [] };
    } else if (kind === 'seq' || kind === 'arp') {
      const id = freeId(seqIdsInUse(band), NUM_SEQS);
      band.sequences[id] = kind === 'seq'
        ? { ...S.defaultSequence(), mode: 'press', noteType: 'scale', notes: [0, 1, 2, 3, 4, 3, 2, 1], gate: 0 }
        : { ...S.defaultSequence(), mode: 'clock', noteType: 'scale', notes: [0, 2, 4], order: 'up', octaves: 2, division: 6, gate: 70 };
      d = { kind, seq: id, gate: kind === 'arp' ? 'hold' : 'latch', onBeat: kind !== 'arp', roles: {} };
    } else if (kind === 'lfo' || kind === 'env') {
      const id = freeId(modIdsInUse(band), NUM_MODS);
      band.modulators[id] = kind === 'lfo'
        ? { ...S.defaultModulator('lfo'), cc: 74, from: 20, to: 110 }
        : { ...S.defaultModulator('env'), cc: 74, from: 10, to: 127, exponential: true };
      d = { kind, mod: id, gate: kind === 'lfo' ? 'latch' : 'hold', onBeat: false, roles: {}, target: null };
    } else {
      d = { kind: 'controls', roles: {} };
    }
    m.devices.push(d);
    return d;
  }

  // Removes a device; its sequence or modulator is cleared if nothing else uses it.
  function removeDevice(band, m, d) {
    m.devices = m.devices.filter((x) => x !== d);
    if (d.kind === 'seq' || d.kind === 'arp') {
      if (!seqIdsInUse(band).has(d.seq)) band.sequences[d.seq] = S.defaultSequence();
      for (const mod of band.modulators) if (mod.follow === d.seq && !seqIdsInUse(band).has(d.seq)) mod.follow = null;
    }
    if ((d.kind === 'lfo' || d.kind === 'env') && !modIdsInUse(band).has(d.mod))
      band.modulators[d.mod] = S.defaultModulator();
  }

  function removeMusician(band, m) {
    for (const d of [...m.devices]) removeDevice(band, m, d);
    band.musicians = band.musicians.filter((x) => x !== m);
  }

  // A sequencer switching between "one note per press" and "by itself":
  // its next-note switch becomes its play switch, and back.
  function setSequenceMode(band, id, mode) {
    band.sequences[id].mode = mode;
    for (const m of band.musicians) for (const d of m.devices) {
      if (d.kind !== 'seq' || d.seq !== id) continue;
      if (mode === 'clock' && d.roles.step !== undefined) {
        if (d.roles.play === undefined || d.roles.play === null) d.roles.play = d.roles.step;
        delete d.roles.step;
      } else if (mode === 'press' && d.roles.play !== undefined) {
        if (d.roles.step === undefined || d.roles.step === null) d.roles.step = d.roles.play;
        delete d.roles.play;
      }
    }
  }

  // --- Switches ---

  // Every place a switch is used: [{input, musician, device, role, key}].
  function slots(band) {
    const out = [];
    for (const m of band.musicians) for (const d of m.devices) {
      if (d.kind === 'notes') {
        d.keys.forEach((k, i) => { if (k.input !== null) out.push({ input: k.input, musician: m, device: d, key: i }); });
      } else {
        for (const [role] of roles(band, d)) {
          const input = d.roles[role];
          if (input !== undefined && input !== null) out.push({ input, musician: m, device: d, role });
        }
      }
    }
    return out;
  }

  function owner(band, input) {
    return slots(band).find((s) => s.input === input) || null;
  }

  // Frees a switch from wherever it is used; returns where it was, or null.
  function release(band, input) {
    const was = owner(band, input);
    for (const m of band.musicians) for (const d of m.devices) {
      if (d.kind === 'notes') d.keys.forEach((k) => { if (k.input === input) k.input = null; });
      else for (const r of Object.keys(d.roles)) if (d.roles[r] === input) d.roles[r] = null;
    }
    return was;
  }

  // Puts a switch in a role ({role} or {key}), freeing it elsewhere first.
  // Returns where it was before, or null.
  function assign(band, d, slot, input) {
    const was = input === null ? null : release(band, input);
    if (slot.key !== undefined) d.keys[slot.key].input = input;
    else d.roles[slot.role] = input;
    return was && !(was.device === d && was.role === slot.role && was.key === slot.key) ? was : null;
  }

  function freeInputs(band) {
    const used = new Set(slots(band).map((s) => s.input));
    return Array.from({ length: S.NUM_INPUTS }, (_, i) => i).filter((i) => !used.has(i));
  }

  // --- Band -> form -> table ---

  // The channel a modulator device acts on: its musician's own, or another's.
  const modChannel = (m, d) => (d.target === null || d.target === undefined ? m.channel : d.target);

  // The form the rule table is built from: one action per switch, with
  // each musician's channel on their notes, sequences and modulators.
  function toForm(band) {
    const f = {
      ...band,
      switches: Array.from({ length: S.NUM_INPUTS }, () => ({ action: 'none' })),
      sequences: band.sequences.map((q) => ({ ...q })),
      modulators: band.modulators.map((m) => ({ ...m })),
    };
    delete f.musicians;
    const seqs = new Set();
    const mods = new Set();
    const set = (input, s) => { if (input !== null && input !== undefined) f.switches[input] = s; };
    for (const m of band.musicians) for (const d of m.devices) {
      const r = d.roles || {};
      if (d.kind === 'notes') {
        for (const k of d.keys)
          set(k.input, d.noteType === 'scale'
            ? { action: 'scale', degree: k.value, gate: d.gate, channel: m.channel }
            : { action: 'note', note: k.value, gate: d.gate, channel: m.channel });
      } else if (d.kind === 'seq' || d.kind === 'arp') {
        if (!seqs.has(d.seq)) f.sequences[d.seq].channel = m.channel;
        seqs.add(d.seq);
        const valid = new Set(roles(band, d).map(([k]) => k));
        if (valid.has('play')) set(r.play, { action: 'seq-play', seq: d.seq, gate: d.gate, onBeat: !!d.onBeat });
        if (valid.has('step')) set(r.step, { action: 'seq-step', seq: d.seq });
        if (valid.has('restart')) set(r.restart, { action: 'seq-restart', seq: d.seq });
      } else if (d.kind === 'lfo' || d.kind === 'env') {
        if (!mods.has(d.mod)) f.modulators[d.mod].channel = modChannel(m, d);
        mods.add(d.mod);
        set(r.run, { action: 'mod-run', mod: d.mod, gate: d.gate, onBeat: !!d.onBeat });
        if (d.kind === 'lfo') set(r.stop, { action: 'mod-stop', mod: d.mod });
      } else if (d.kind === 'controls') {
        for (const [key, , semitones] of CONTROL_ROLES)
          set(r[key], semitones === null ? { action: 'preset-next' } : { action: 'transpose', semitones });
      }
    }
    // Sequences and modulators no device uses aren't sent to the board.
    for (let id = 0; id < NUM_SEQS; id++) if (!seqs.has(id)) f.sequences[id] = { ...f.sequences[id], notes: [] };
    for (let id = 0; id < NUM_MODS; id++) if (!mods.has(id)) f.modulators[id] = { ...f.modulators[id], kind: 'off' };
    return f;
  }

  // The musicians as stored in the EDITOR section: everything except the
  // sequences' notes and the modulators' shapes, which the table holds.
  function editorJson(band) {
    return {
      v: EDITOR_VERSION,
      m: band.musicians.map((m) => ({
        n: m.name, c: m.colour, ch: m.channel,
        d: m.devices.map((d) => {
          const out = { k: d.kind };
          if (d.kind === 'notes') Object.assign(out, { t: d.noteType, g: d.gate, keys: d.keys.map((k) => [k.input, k.value]) });
          if (d.seq !== undefined) out.s = d.seq;
          if (d.mod !== undefined) out.o = d.mod;
          if (d.gate !== undefined && d.kind !== 'notes') out.g = d.gate;
          if (d.onBeat) out.b = 1;
          if (d.target !== undefined && d.target !== null) out.ch = d.target;
          if (d.roles) {
            const r = {};
            for (const [k, v] of Object.entries(d.roles)) if (v !== null && v !== undefined) r[k] = v;
            out.r = r;
          }
          return out;
        }),
      })),
    };
  }

  function editorSection(band) {
    const body = Array.from(new TextEncoder().encode(JSON.stringify(editorJson(band))));
    return [EDITOR_ID, 0, body.length & 0xff, (body.length >> 8) & 0xff, ...body];
  }

  function tableFromBand(band) {
    const table = S.tableFromForm(toForm(band));
    const editor = editorSection(band);
    // The musicians only go along if there's room; without them the preset
    // still plays, and reopens as one musician per channel.
    table.extra = S.buildTable(table).length + editor.length <= MAX_TABLE_LEN ? [editor] : [];
    return table;
  }

  // --- Table -> band ---

  const isInput = (v) => v === null || (Number.isInteger(v) && v >= 0 && v < S.NUM_INPUTS);
  const GATES = ['hold', 'latch', 'oneshot'];

  // The musicians from an EDITOR section, checked; null if unusable.
  function readEditor(section) {
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(Uint8Array.from(section.slice(4))));
    } catch (e) {
      return null;
    }
    if (!data || data.v !== EDITOR_VERSION || !Array.isArray(data.m) || data.m.length > MAX_MUSICIANS) return null;
    const musicians = [];
    for (const m of data.m) {
      if (!m || typeof m.n !== 'string' || !Number.isInteger(m.c) || m.c < 0 || m.c >= COLOURS.length ||
          !Number.isInteger(m.ch) || m.ch < 0 || m.ch > 15 || !Array.isArray(m.d)) return null;
      const devices = [];
      for (const x of m.d) {
        if (!x || !KINDS.includes(x.k)) return null;
        const d = { kind: x.k };
        if (x.k === 'notes') {
          if (!['scale', 'fixed'].includes(x.t) || !GATES.includes(x.g) || !Array.isArray(x.keys)) return null;
          d.noteType = x.t;
          d.gate = x.g;
          d.keys = [];
          for (const k of x.keys) {
            if (!Array.isArray(k) || !isInput(k[0]) || !Number.isInteger(k[1])) return null;
            d.keys.push({ input: k[0], value: k[1] });
          }
        } else {
          const r = x.r && typeof x.r === 'object' ? x.r : {};
          d.roles = {};
          for (const [k, v] of Object.entries(r)) {
            if (!isInput(v)) return null;
            d.roles[k] = v;
          }
          if (DEVICES[x.k].uses === 'seq') {
            if (!Number.isInteger(x.s) || x.s < 0 || x.s >= NUM_SEQS) return null;
            d.seq = x.s;
          }
          if (DEVICES[x.k].uses === 'mod') {
            if (!Number.isInteger(x.o) || x.o < 0 || x.o >= NUM_MODS) return null;
            d.mod = x.o;
            d.target = Number.isInteger(x.ch) && x.ch >= 0 && x.ch <= 15 ? x.ch : null;
          }
          if (x.k !== 'controls') {
            d.gate = GATES.includes(x.g) ? x.g : 'hold';
            d.onBeat = !!x.b;
          }
        }
        devices.push(d);
      }
      musicians.push({ name: m.n.slice(0, 24), colour: m.c, channel: m.ch, devices });
    }
    return musicians;
  }

  // Rules in a comparable form (built rules leave zero fields out).
  const ruleKey = (r) => [r.trig, r.src || 0, r.arg || 0, r.act, r.flags || 0, r.p0 || 0, r.p1 || 0,
    r.p2 || 0, r.p3 || 0].join(',');

  // Returns {band} or {reason} if the table uses things this editor can't show.
  function bandFromTable(table) {
    const extra = table.extra || [];
    const editor = extra.find((s) => s[0] === EDITOR_ID);
    const result = S.formFromTable({ ...table, extra: extra.filter((s) => s[0] !== EDITOR_ID) });
    if (!result.form) return { reason: result.reason };
    const form = result.form;
    if (editor) {
      const musicians = readEditor(editor);
      if (musicians) {
        const band = { ...form, musicians };
        delete band.switches;
        // Use the stored musicians only if they still make the same rules
        // (another tool may have changed the table since).
        const rules = S.tableFromForm(toForm(band)).rules.map(ruleKey).join(';');
        if (rules === table.rules.map(ruleKey).join(';')) return { band };
      }
    }
    return { band: bandFromForm(form) };
  }

  // A form (an older preset, or one without musicians) as a band: one
  // musician per MIDI channel, with a device for each kind of switch.
  function bandFromForm(form) {
    const band = { ...form, musicians: [] };
    delete band.switches;
    const byChannel = new Map();
    const musicianFor = (channel) => {
      const ch = channel === undefined || channel === null ? form.channel : channel;
      if (!byChannel.has(ch)) {
        const m = { name: `Musician ${band.musicians.length + 1}`, colour: band.musicians.length % COLOURS.length, channel: ch, devices: [] };
        if (band.musicians.length < MAX_MUSICIANS) band.musicians.push(m);
        else return byChannel.get([...byChannel.keys()][0]);
        byChannel.set(ch, m);
      }
      return byChannel.get(ch);
    };
    // Finds a device of a kind (and sequence or modulator) whose role is free.
    const deviceFor = (m, kind, extra, role, gate, onBeat) => {
      let d = m.devices.find((x) => x.kind === kind && Object.entries(extra).every(([k, v]) => x[k] === v) &&
        (x.roles[role] === undefined || x.roles[role] === null) &&
        (gate === undefined || x.gate === undefined || (x.gate === gate && x.onBeat === onBeat)));
      if (!d) {
        d = { kind, ...extra, roles: {} };
        if (kind !== 'controls') Object.assign(d, { gate: gate || 'hold', onBeat: !!onBeat });
        if (kind === 'lfo' || kind === 'env') d.target = null;
        m.devices.push(d);
      }
      if (gate !== undefined && d.gate !== undefined) Object.assign(d, { gate, onBeat: !!onBeat });
      return d;
    };
    const seqKind = (id, hasStep) => {
      const q = form.sequences[id];
      return q.mode === 'clock' && q.order !== 'written' && q.noteType === 'scale' && !hasStep ? 'arp' : 'seq';
    };
    const stepped = new Set(form.switches.filter((s) => s.action === 'seq-step' || s.action === 'seq-restart').map((s) => s.seq));

    form.switches.forEach((s, input) => {
      if (s.action === 'scale' || s.action === 'note') {
        const m = musicianFor(s.channel);
        const noteType = s.action === 'scale' ? 'scale' : 'fixed';
        let d = m.devices.find((x) => x.kind === 'notes' && x.noteType === noteType && x.gate === s.gate);
        if (!d) m.devices.push(d = { kind: 'notes', noteType, gate: s.gate, keys: [] });
        d.keys.push({ input, value: noteType === 'scale' ? s.degree : s.note });
      } else if (s.action.startsWith('seq-')) {
        const q = form.sequences[s.seq];
        const m = musicianFor(q.channel);
        const role = { 'seq-play': 'play', 'seq-step': 'step', 'seq-restart': 'restart' }[s.action];
        const kind = seqKind(s.seq, stepped.has(s.seq));
        // A press-mode sequence is stepped; a clock one is played.
        const fixedRole = q.mode === 'press' && role === 'play' ? 'step' : q.mode === 'clock' && role === 'step' ? 'play' : role;
        const d = s.action === 'seq-play'
          ? deviceFor(m, kind, { seq: s.seq }, fixedRole, s.gate, s.onBeat)
          : deviceFor(m, kind, { seq: s.seq }, fixedRole);
        d.roles[fixedRole] = input;
      } else if (s.action.startsWith('mod-')) {
        const mod = form.modulators[s.mod];
        const kind = mod.kind === 'env' ? 'env' : 'lfo';
        const m = musicianFor(mod.channel);
        const role = s.action === 'mod-run' ? 'run' : 'stop';
        const d = s.action === 'mod-run'
          ? deviceFor(m, kind, { mod: s.mod }, role, s.gate, s.onBeat)
          : deviceFor(m, kind, { mod: s.mod }, role);
        d.roles[role] = input;
      } else if (s.action === 'transpose' || s.action === 'preset-next') {
        const m = musicianFor(undefined);
        let key = 'next';
        if (s.action === 'transpose') {
          const big = Math.abs(s.semitones) >= 7;
          key = s.semitones < 0 ? (big ? 'down' : 'sdown') : (big ? 'up' : 'sup');
        }
        const d = deviceFor(m, 'controls', {}, key);
        d.roles[key] = input;
      }
    });
    // Sequences and modulators with no switch (an envelope that follows a
    // sequence, say) still get a device, so they aren't lost.
    const seqs = seqIdsInUse(band);
    form.sequences.forEach((q, id) => {
      if (q.notes.length && !seqs.has(id)) deviceFor(musicianFor(q.channel), seqKind(id, false), { seq: id }, 'play', 'hold', false);
    });
    const mods = modIdsInUse(band);
    form.modulators.forEach((mod, id) => {
      if (mod.kind !== 'off' && !mods.has(id)) deviceFor(musicianFor(mod.channel), mod.kind, { mod: id }, 'run', 'hold', false);
    });
    for (const m of band.musicians) {
      // Modulators were put with the musician on their channel already.
      for (const d of m.devices) if (d.kind === 'lfo' || d.kind === 'env') d.target = null;
    }
    if (!band.musicians.length) addMusician(band);
    return band;
  }

  // --- Starter templates ---
  // Each returns a fresh band. Names fit the board's 16 characters.

  function start(name, setup) {
    const b = defaultBand();
    b.name = name;
    setup(b);
    return b;
  }
  function player(b, name, channel) {
    const m = addMusician(b, name);
    if (channel !== undefined) m.channel = channel;
    return m;
  }
  function notes(m, noteType, gate, pairs) {
    const d = { kind: 'notes', noteType, gate, keys: pairs.map(([input, value]) => ({ input, value })) };
    m.devices.push(d);
    return d;
  }
  function seqDevice(b, m, kind, sequence, roleInputs, gate = 'latch', onBeat = true) {
    const d = addDevice(b, m, kind);
    Object.assign(b.sequences[d.seq], sequence);
    Object.assign(d, { gate, onBeat, roles: roleInputs });
    return d;
  }
  function modDevice(b, m, kind, shape, roleInputs, gate, onBeat = false) {
    const d = addDevice(b, m, kind);
    Object.assign(b.modulators[d.mod], shape);
    Object.assign(d, { gate, onBeat, roles: roleInputs });
    return d;
  }
  const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);

  const TEMPLATES = [
    {
      id: 'scale', name: 'Scale player',
      description: 'One musician: switches 1–10 play up the scale, and the buttons shift everyone an octave down and up.',
      band: () => start('Scale player', (b) => {
        const m = player(b, 'Player 1', 0);
        notes(m, 'scale', 'hold', range(0, 10).map((i) => [i, i]));
        m.devices.push({ kind: 'controls', roles: { down: 10, up: 11 } });
      }),
    },
    {
      id: 'four', name: 'Four players',
      description: 'A workshop band in C major pentatonic. Melody plays notes on switches 1–4; Chords starts an arpeggio (5) and a wobble (6); Tune steps through a tune (7, back to the start on 8); Drums plays kick and snare (9, 10) and starts a beat (right button).',
      band: () => start('Four players', (b) => {
        b.mask = 0x0295;  // major pentatonic
        b.tempo = 1000;
        notes(player(b, 'Melody', 0), 'scale', 'hold', range(0, 4).map((i) => [i, i]));
        const chords = player(b, 'Chords', 1);
        seqDevice(b, chords, 'arp', { notes: [0, 2, 4], order: 'updown', octaves: 2, division: 12, gate: 80 }, { play: 4 });
        modDevice(b, chords, 'lfo', { cc: 74, from: 30, to: 120, wave: 'sine', synced: true, rate: 192 }, { run: 5 }, 'latch', true);
        const tune = player(b, 'Tune', 2);
        seqDevice(b, tune, 'seq', { mode: 'press', notes: [4, 4, 3, 2, 1, 2, 3, 4, 0, 1, 2], gate: 0 }, { step: 6, restart: 7 });
        const drums = player(b, 'Drums', 9);
        notes(drums, 'fixed', 'oneshot', [[8, 36], [9, 38]]);
        seqDevice(b, drums, 'seq', { mode: 'clock', noteType: 'fixed', notes: [36, 42, 38, 42, 36, 36, 38, 42], division: 12, gate: 50 }, { play: 11 });
      }),
    },
    {
      id: 'chords', name: 'Chord arpeggios',
      description: 'Chords: four arpeggios (I, IV, V and vi) that play while switches 1–4 are held. Bass: two bass notes on switches 5 and 6.',
      band: () => start('Chord arps', (b) => {
        b.tempo = 1100;
        const chords = player(b, 'Chords', 0);
        [[0, 2, 4], [3, 5, 7], [4, 6, 8], [5, 7, 9]].forEach((n, i) =>
          seqDevice(b, chords, 'arp', { notes: n, order: 'up', octaves: 2, division: 6, gate: 70 }, { play: i }, 'hold', false));
        notes(player(b, 'Bass', 1), 'scale', 'hold', [[4, -7], [5, -3]]);
      }),
    },
    {
      id: 'tune', name: 'Tune stepper',
      description: 'Two musicians step through tunes, one note per press: Ode to Joy on switch 1, Twinkle Twinkle on switch 3. Switches 2 and 4 go back to the start. A third musician plays scale notes on 5–10.',
      band: () => start('Tune stepper', (b) => {
        const ode = [2, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1, 2, 2, 1, 1, 2, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1, 2, 1, 0, 0];
        const twinkle = [0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0];
        seqDevice(b, player(b, 'Ode to Joy', 0), 'seq', { mode: 'press', notes: ode, gate: 0 }, { step: 0, restart: 1 });
        seqDevice(b, player(b, 'Twinkle', 1), 'seq', { mode: 'press', notes: twinkle, gate: 0 }, { step: 2, restart: 3 });
        notes(player(b, 'Notes', 2), 'scale', 'hold', range(4, 6).map((i) => [i, i - 4]));
      }),
    },
    {
      id: 'drums', name: 'Drum pads',
      description: 'General MIDI drums on channel 10. Drums: one drum per switch. Beats: the buttons start and stop a beat and a hi-hat pattern. Best with a DAW drum kit.',
      band: () => start('Drum pads', (b) => {
        notes(player(b, 'Drums', 9), 'fixed', 'oneshot',
          [36, 38, 42, 46, 39, 45, 48, 49, 51, 56].map((note, i) => [i, note]));
        const beats = player(b, 'Beats', 9);
        seqDevice(b, beats, 'seq', { mode: 'clock', noteType: 'fixed', notes: [36, null, 38, null, 36, 36, 38, null], division: 12, gate: 50 }, { play: 10 });
        seqDevice(b, beats, 'seq', { mode: 'clock', noteType: 'fixed', notes: [42, 42, 42, 46], division: 12, gate: 50 }, { play: 11 });
        b.analog = [{ cc: 7 }, { cc: null }];
      }),
    },
    {
      id: 'euclid', name: 'Euclidean drums',
      description: 'Rhythms: four drum parts with Euclidean rhythms, started and stopped on the beat by switches 1–4. Pads: drum pads on 5–10. Best with a DAW drum kit.',
      band: () => start('Euclid drums', (b) => {
        b.tempo = 1000;
        const rhythms = player(b, 'Rhythms', 9);
        [[36, 16, 5, 0], [38, 16, 3, 4], [42, 8, 7, 0], [45, 12, 4, 2]].forEach(([note, steps, hits, rotation], i) =>
          seqDevice(b, rhythms, 'seq', { mode: 'clock', noteType: 'fixed', notes: [note], division: 6, gate: 50, rhythm: { steps, hits, rotation } }, { play: i }));
        notes(player(b, 'Pads', 9), 'fixed', 'oneshot', [36, 38, 42, 46, 39, 49].map((note, i) => [4 + i, note]));
        b.analog = [{ cc: 7 }, { cc: null }];
      }),
    },
    {
      id: 'mod', name: 'Sweeps & wobbles',
      description: 'Keys plays scale notes on switches 5–10. Effects changes Keys’ sound: a brightness sweep while switch 1 is held, a vibrato wobble on 2, and a pitch bend up and back on 3. Arp plays an arpeggio on 4 with a brightness pluck on each note.',
      band: () => start('Sweeps & wobble', (b) => {
        const keys = player(b, 'Keys', 0);
        notes(keys, 'scale', 'hold', range(4, 6).map((i) => [i, i - 4]));
        const fx = player(b, 'Effects', 1);
        const onKeys = (d) => { d.target = 0; return d; };
        onKeys(modDevice(b, fx, 'env', { output: 'cc', cc: 74, from: 10, to: 127, exponential: true, attack: 1500, decay: 0, sustain: 100, release: 1200 }, { run: 0 }, 'hold'));
        onKeys(modDevice(b, fx, 'lfo', { output: 'cc', cc: 1, from: 0, to: 90, wave: 'triangle', synced: true, rate: 96 }, { run: 1 }, 'latch', true));
        onKeys(modDevice(b, fx, 'env', { output: 'bend', from: 64, to: 76, attack: 60, decay: 300, sustain: 0, release: 0 }, { run: 2 }, 'oneshot'));
        const arp = player(b, 'Arp', 2);
        const a = seqDevice(b, arp, 'arp', { notes: [0, 2, 4], order: 'up', octaves: 2, division: 6, gate: 60 }, { play: 3 }, 'hold', false);
        modDevice(b, arp, 'env', { output: 'cc', cc: 74, from: 20, to: 110, attack: 5, decay: 150, sustain: 30, release: 120, follow: a.seq }, {}, 'hold');
      }),
    },
  ];

  global.SwitchcraftBand = {
    COLOURS, DEVICES, KINDS, MAX_MUSICIANS, NUM_SEQS, NUM_MODS, TEMPLATES, EDITOR_ID,
    roles, defaultBand, addMusician, removeMusician, addDevice, removeDevice, canAdd,
    setSequenceMode, slots, owner, release, assign, freeInputs, seqIdsInUse, modIdsInUse,
    toForm, tableFromBand, bandFromTable, bandFromForm, editorJson,
  };
})(typeof window !== 'undefined' ? window : globalThis);
